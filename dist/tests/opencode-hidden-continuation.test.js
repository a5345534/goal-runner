import test from "node:test";
import assert from "node:assert/strict";
import { startOpencodeHiddenGoalTurn, OpencodeHiddenContinuationRegistry, rewriteOpencodeQueuedContinuations, extractOpencodeGoalContinuationMetadata, extractOpencodeEventSessionID, isOpencodeSessionIdleEvent, isOpencodeSessionErrorEvent, isOpencodeSessionCompactedEvent, } from "../adapters/opencode/index.js";
function makeClient(record) {
    return {
        session: {
            prompt: async ({ sessionID, parts }) => {
                record.calls.push({ sessionID, text: parts?.[0]?.text ?? "" });
                return { data: { ok: true } };
            },
        },
    };
}
const fixture = {
    attemptId: "att-1",
    sessionKey: "opencode:ses_1",
    goalId: "goal-abc",
    goalUpdatedAt: "2026-06-02T00:00:00.000Z",
    attemptCount: 1,
    hiddenContextKind: "goal_continuation",
    renderedPrompt: "Continue with the goal.",
};
test("startOpencodeHiddenGoalTurn sends a continuation text part and remembers the attempt", async () => {
    const record = { calls: [] };
    const client = makeClient(record);
    const registry = new OpencodeHiddenContinuationRegistry();
    const result = await startOpencodeHiddenGoalTurn({ client, sessionID: "ses_1" }, fixture, registry);
    assert.equal(result.kind, "started");
    assert.equal(registry.size(), 1);
    assert.equal(record.calls.length, 1);
    assert.equal(record.calls[0]?.sessionID, "ses_1");
    assert.match(record.calls[0]?.text ?? "", /<agent_goal_continuation goal_id="goal-abc"/);
    assert.match(record.calls[0]?.text ?? "", /Continue with the goal/);
});
test("startOpencodeHiddenGoalTurn returns alreadyStarted on the second attempt", async () => {
    const record = { calls: [] };
    const client = makeClient(record);
    const registry = new OpencodeHiddenContinuationRegistry();
    await startOpencodeHiddenGoalTurn({ client, sessionID: "ses_1" }, fixture, registry);
    const second = await startOpencodeHiddenGoalTurn({ client, sessionID: "ses_1" }, fixture, registry);
    assert.equal(second.kind, "alreadyStarted");
    assert.equal(record.calls.length, 1, "should not call prompt twice for the same attemptId");
});
test("startOpencodeHiddenGoalTurn skips when the session is busy", async () => {
    const record = { calls: [] };
    const client = makeClient(record);
    const registry = new OpencodeHiddenContinuationRegistry();
    const result = await startOpencodeHiddenGoalTurn({ client, sessionID: "ses_1", busy: () => true }, fixture, registry);
    assert.equal(result.kind, "skipped");
    assert.equal(record.calls.length, 0);
});
test("startOpencodeHiddenGoalTurn skips when user input is queued", async () => {
    const record = { calls: [] };
    const client = makeClient(record);
    const registry = new OpencodeHiddenContinuationRegistry();
    const result = await startOpencodeHiddenGoalTurn({ client, sessionID: "ses_1", hasQueuedUserInput: () => true }, fixture, registry);
    assert.equal(result.kind, "skipped");
    assert.match(result.reason ?? "", /user input/);
    assert.equal(record.calls.length, 0);
});
test("startOpencodeHiddenGoalTurn returns fatalFailure when the client has no prompt", async () => {
    const registry = new OpencodeHiddenContinuationRegistry();
    const result = await startOpencodeHiddenGoalTurn({ client: { session: {} }, sessionID: "ses_1" }, fixture, registry);
    assert.equal(result.kind, "fatalFailure");
    assert.match(result.error, /session\.prompt/);
});
test("startOpencodeHiddenGoalTurn reports retryableFailure on prompt error", async () => {
    const registry = new OpencodeHiddenContinuationRegistry();
    const client = {
        session: {
            prompt: async () => ({ error: "ECONNRESET" }),
        },
    };
    const result = await startOpencodeHiddenGoalTurn({ client, sessionID: "ses_1" }, fixture, registry);
    assert.equal(result.kind, "retryableFailure");
    assert.match(result.error, /ECONNRESET/);
});
test("extractOpencodeGoalContinuationMetadata parses marker attributes", () => {
    const text = '<agent_goal_continuation goal_id="goal-1" goal_updated_at="2026-06-02T00:00:00.000Z" attempt_id="att-1">\nbody\n</agent_goal_continuation>';
    const metadata = extractOpencodeGoalContinuationMetadata(text);
    assert.deepEqual(metadata, {
        goalId: "goal-1",
        goalUpdatedAt: "2026-06-02T00:00:00.000Z",
        attemptId: "att-1",
    });
});
test("extractOpencodeGoalContinuationMetadata returns undefined for non-marker text", () => {
    assert.equal(extractOpencodeGoalContinuationMetadata("hello world"), undefined);
});
test("rewriteOpencodeQueuedContinuations marks stale messages but keeps the latest current", () => {
    const messages = [
        messageWithPart('<agent_goal_continuation goal_id="goal-old">old</agent_goal_continuation>'),
        messageWithPart('<agent_goal_continuation goal_id="goal-current" goal_updated_at="2026-06-02T00:00:00.000Z">newer</agent_goal_continuation>'),
        messageWithPart('<agent_goal_continuation goal_id="goal-current" goal_updated_at="2026-06-02T00:00:00.000Z">latest</agent_goal_continuation>'),
    ];
    const isCurrent = (m) => m.goalId === "goal-current";
    const result = rewriteOpencodeQueuedContinuations(messages, isCurrent, "goal-current");
    assert.equal(result.changed, true);
    // First is stale (not current)
    assert.match(result.messages[0]?.parts[0]?.text ?? "", /Stale hidden goal continuation/);
    // Second is superseded (current but not latest)
    assert.match(result.messages[1]?.parts[0]?.text ?? "", /Superseded hidden goal continuation/);
    // Third is kept verbatim (latest current)
    assert.match(result.messages[2]?.parts[0]?.text ?? "", /latest/);
});
test("rewriteOpencodeQueuedContinuations is a no-op when there are no continuation messages", () => {
    const messages = [messageWithPart("hello")];
    const result = rewriteOpencodeQueuedContinuations(messages, () => false);
    assert.equal(result.changed, false);
    assert.deepEqual(result.messages, messages);
});
test("event helpers recognise the opencode lifecycle events", () => {
    assert.equal(isOpencodeSessionIdleEvent({ type: "session.idle" }), true);
    assert.equal(isOpencodeSessionErrorEvent({ type: "session.error", properties: { error: "boom" } }), true);
    assert.equal(isOpencodeSessionCompactedEvent({ type: "session.compacted" }), true);
    assert.equal(isOpencodeSessionIdleEvent({ type: "session.error" }), false);
    assert.equal(extractOpencodeEventSessionID({ type: "session.idle", properties: { sessionID: "ses_1" } }), "ses_1");
    assert.equal(extractOpencodeEventSessionID({ type: "session.idle" }), undefined);
});
function messageWithPart(text) {
    return {
        info: {},
        parts: [{ type: "text", text }],
    };
}
//# sourceMappingURL=opencode-hidden-continuation.test.js.map