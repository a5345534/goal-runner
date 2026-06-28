import test from "node:test";
import assert from "node:assert/strict";
import {
  readOpencodeSessionMessages,
  readOpencodeTokenUsage,
  summariseOpencodeSession,
  buildOpencodeCompletionEvidence,
  type OpencodeMessage,
} from "../adapters/opencode/index.js";

function makeClient(messages: OpencodeMessage[]) {
  return {
    session: {
      messages: async ({ sessionID }: { sessionID: string }) => ({ data: messages, sessionID }),
    },
  };
}

const baseMessage = (overrides: Partial<OpencodeMessage> = {}): OpencodeMessage => ({
  id: overrides.id ?? "msg-1",
  role: overrides.role ?? "user",
  parts: overrides.parts ?? [{ type: "text", text: "hello" }],
  time: overrides.time ?? { created: Date.parse("2026-06-02T00:00:00.000Z"), completed: Date.parse("2026-06-02T00:00:01.000Z") },
  ...overrides,
});

test("readOpencodeSessionMessages returns empty when the client has no session", async () => {
  const messages = await readOpencodeSessionMessages({ client: {}, sessionID: "ses_1" });
  assert.deepEqual(messages, []);
});

test("readOpencodeSessionMessages passes the session id and returns the data", async () => {
  const client = makeClient([baseMessage({ id: "msg-1" })]);
  const messages = await readOpencodeSessionMessages({ client, sessionID: "ses_2" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, "msg-1");
});

test("readOpencodeTokenUsage sums input/output across assistant messages", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "u1", role: "user" }),
    baseMessage({ id: "a1", role: "assistant", tokens: { input: 100, output: 200 } }),
    baseMessage({ id: "a2", role: "assistant", tokens: { input: 50, output: 80, cache: { read: 10, write: 5 } } }),
  ];
  const usage = readOpencodeTokenUsage(messages);
  assert.equal(usage.inputTokens, 150);
  assert.equal(usage.outputTokens, 280);
  assert.equal(usage.totalTokens, 430);
});

test("readOpencodeTokenUsage returns no usage when no assistant tokens exist", () => {
  const messages: OpencodeMessage[] = [baseMessage({ role: "user" })];
  const usage = readOpencodeTokenUsage(messages);
  assert.deepEqual(usage, {});
});

test("summariseOpencodeSession detects SUBAGENT_RESULT / SUBAGENT_BLOCKED markers", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "Working on it." }] }),
    baseMessage({ id: "a2", role: "assistant", parts: [{ type: "text", text: "SUBAGENT_RESULT: attendance doctypes added and tests passed" }] }),
  ];
  const snapshot = summariseOpencodeSession(messages);
  assert.equal(snapshot.hasResultMarker, true);
  assert.equal(snapshot.hasBlockedMarker, false);
});

test("summariseOpencodeSession detects blocked markers in tool result and assistant text", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "SUBAGENT_STATUS: blocked" }] }),
    baseMessage({ id: "a2", role: "assistant", parts: [{ type: "text", text: "Awaiting controller input." }] }),
  ];
  const snapshot = summariseOpencodeSession(messages);
  assert.equal(snapshot.hasBlockedMarker, true);
  assert.equal(snapshot.hasResultMarker, false);
});

test("summariseOpencodeSession surfaces the most recent tool name", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "tool", tool: "bash", callID: "c1" }] }),
    baseMessage({ id: "a2", role: "assistant", parts: [{ type: "tool", tool: "edit", callID: "c2" }] }),
  ];
  const snapshot = summariseOpencodeSession(messages);
  assert.equal(snapshot.lastToolName, "edit");
});

test("buildOpencodeCompletionEvidence collects commands, signals, and tool names", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "Running tests." }] }),
    baseMessage({
      id: "a2",
      role: "assistant",
      parts: [{ type: "tool", tool: "bash", args: { command: "npm test" } } as never],
    }),
    baseMessage({
      id: "a3",
      role: "assistant",
      parts: [{ type: "text", text: "Test result: all tests passed" }],
    }),
  ];
  const evidence = buildOpencodeCompletionEvidence("implement feature", messages, "/repo");
  assert.equal(evidence.source, "opencode-session-transcript");
  assert.deepEqual(evidence.toolNames, ["bash"]);
  assert.deepEqual(evidence.commands, ["npm test"]);
  assert.ok(evidence.verificationSignals && evidence.verificationSignals.length > 0);
  assert.equal(evidence.objective, "implement feature");
  assert.equal(evidence.cwd, "/repo");
});

test("buildOpencodeCompletionEvidence returns empty signals for a pure status transcript", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "u1", role: "user" }),
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "I am considering options." }] }),
  ];
  const evidence = buildOpencodeCompletionEvidence("consider options", messages, "/repo");
  assert.deepEqual(evidence.commands, []);
  assert.deepEqual(evidence.toolNames, []);
});

test("summariseOpencodeSession detects SUBAGENT_QUESTION marker", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: [
      "I have a question about the approach.",
      "SUBAGENT_QUESTION:",
      "- question: Which approach should I use?",
      "- options:",
      "  - A: Simple approach",
      "  - B: Complex approach",
      "- recommended default: A",
      "- blocking: no",
    ].join("\n") }] }),
  ];
  const snapshot = summariseOpencodeSession(messages);
  assert.equal(snapshot.hasQuestionMarker, true);
  assert.equal(snapshot.hasResultMarker, false);
  assert.equal(snapshot.hasBlockedMarker, false);
});

test("summariseOpencodeSession prioritizes RESULT over QUESTION when both are present", () => {
  const messages: OpencodeMessage[] = [
    baseMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: [
      "SUBAGENT_QUESTION:",
      "- question: Which test framework?",
      "- blocking: no",
      "",
      "SUBAGENT_RESULT: completed implementation",
    ].join("\n") }] }),
  ];
  const snapshot = summariseOpencodeSession(messages);
  assert.equal(snapshot.hasResultMarker, true, "result marker should be detected");
  assert.equal(snapshot.hasQuestionMarker, true, "question marker should also be detected");
  assert.equal(snapshot.hasBlockedMarker, false);
});
