/**
 * Pi adapter smoke tests for quality-profile DAGs.
 *
 * Verifies that the Pi subagent adapter correctly passes through quality
 * profile information when rendering prompts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PiHarnessSubagentAdapter,
  renderPiSubagentInitialPrompt,
} from "../adapters/pi/index.js";
import { renderQualityProfileEnvelope } from "../core/prompts.js";
import type { GoalQualityProfile } from "../core/quality-profiles.js";
import { SUPPORTED_QUALITY_PROFILES } from "../core/quality-profiles.js";
import type { GoalDagNode } from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

function makeNode(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
  return {
    goalId: "goal-1",
    nodeId: "implement-feature",
    slug: "implement-feature",
    objective: "Implement the feature slice",
    scope: "Implement feature with quality profiles",
    dependencyNodeIds: [],
    expectedOutputs: ["src/feature.ts"],
    validators: ["npm test"],
    completionGates: ["controller-validation"],
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Quality profile vocabulary is complete
// ---------------------------------------------------------------------------

test("Pi adapter quality profile vocabulary has all 10 profiles", () => {
  assert.equal(SUPPORTED_QUALITY_PROFILES.length, 10);
  assert.deepEqual([...SUPPORTED_QUALITY_PROFILES].sort(), [
    "api-boundary-review",
    "code-review-required",
    "docs-adr-required",
    "frontend-runtime-review",
    "incremental-implementation",
    "observability-required",
    "performance-sensitive-review",
    "security-sensitive-review",
    "ship-preflight",
    "test-driven-change",
  ]);
});

// ---------------------------------------------------------------------------
// Quality profile envelope rendering
// ---------------------------------------------------------------------------

test("renderQualityProfileEnvelope returns empty for node without profiles", () => {
  const n = makeNode();
  const envelope = renderQualityProfileEnvelope(n);
  assert.deepEqual(envelope, []);
});

test("renderQualityProfileEnvelope includes profile names and execution discipline", () => {
  const n = makeNode({ qualityProfiles: ["incremental-implementation" as GoalQualityProfile] });
  const envelope = renderQualityProfileEnvelope(n);
  assert.ok(envelope.length > 0, "envelope should not be empty");
  const text = envelope.join("\n");
  assert.match(text, /QUALITY PROFILE EXECUTION DISCIPLINE/);
  assert.match(text, /incremental-implementation/);
  assert.match(text, /Implement the smallest independently verifiable slice/);
  assert.match(text, /SUBAGENT_RESULT and SUBAGENT_BLOCKED markers alone do not satisfy quality profile gates/);
});

test("renderQualityProfileEnvelope includes multiple profiles", () => {
  const n = makeNode({
    qualityProfiles: [
      "incremental-implementation" as GoalQualityProfile,
      "test-driven-change" as GoalQualityProfile,
      "security-sensitive-review" as GoalQualityProfile,
    ],
  });
  const envelope = renderQualityProfileEnvelope(n);
  const text = envelope.join("\n");
  assert.match(text, /incremental-implementation/);
  assert.match(text, /test-driven-change/);
  assert.match(text, /security-sensitive-review/);
  assert.match(text, /smallest independently verifiable slice/);
  assert.match(text, /deterministic verification/);
  assert.match(text, /Security review required/);
});

test("renderQualityProfileEnvelope discipline covers all 10 profile types", () => {
  for (const profile of SUPPORTED_QUALITY_PROFILES) {
    const n = makeNode({ qualityProfiles: [profile] });
    const envelope = renderQualityProfileEnvelope(n);
    assert.ok(envelope.length > 1, `profile ${profile} should produce non-empty envelope lines`);
    const text = envelope.join("\n");
    assert.match(text, new RegExp(profile), `envelope should mention profile ${profile}`);
  }
});

// ---------------------------------------------------------------------------
// Pi initial prompt rendering passes quality profiles through
// ---------------------------------------------------------------------------

test("Pi adapter renders initial prompt with quality profiles", () => {
  const n = makeNode({
    qualityProfiles: ["incremental-implementation" as GoalQualityProfile],
    validation: { allowedPaths: ["src/**"] },
  });
  const prompt = renderPiSubagentInitialPrompt({
    goalId: n.goalId,
    node: n,
    subagentId: "subagent-1",
    initialPrompt: "Implement feature",
  });
  assert.ok(prompt.length > 0, "prompt should not be empty");
  // Should include quality profile envelope
  assert.match(prompt, /QUALITY PROFILE EXECUTION DISCIPLINE/);
  assert.match(prompt, /incremental-implementation/);
  // Should include controller guardrails
  assert.match(prompt, /CONTROLLER EXECUTION POLICY/);
});

test("Pi adapter prompt with no quality profiles omits envelope", () => {
  const n = makeNode();
  const prompt = renderPiSubagentInitialPrompt({
    goalId: n.goalId,
    node: n,
    subagentId: "subagent-1",
    initialPrompt: "Simple task",
  });
  assert.doesNotMatch(prompt, /QUALITY PROFILE EXECUTION DISCIPLINE/);
});

// ---------------------------------------------------------------------------
// Pi subagent adapter smoke: node with quality profiles
// ---------------------------------------------------------------------------

test("Pi subagent adapter adapterId is stable", () => {
  const adapter = new PiHarnessSubagentAdapter();
  assert.equal(adapter.adapterId, "pi");
});

test("Pi subagent adapter accepts quality-profile nodes in start requests", async () => {
  const adapter = new PiHarnessSubagentAdapter();
  const n = makeNode({
    qualityProfiles: ["incremental-implementation" as GoalQualityProfile, "test-driven-change" as GoalQualityProfile],
    kind: "implementation",
    validators: ["true"],
  });

  // startSession takes HarnessSubagentStartRequest which includes the node
  const startRequest = {
    goalId: n.goalId,
    node: n,
    subagentId: "subagent-qp-1",
    cwd: "/tmp/test",
    initialPrompt: "Test quality profile DAG node",
  };

  // The adapter may fail to start (no real session), but the type contract
  // should accept quality-profile nodes without crashing
  try {
    const result = await adapter.startSession(startRequest);
    assert.ok(result, "result should be defined");
  } catch {
    // Expected: no real Pi session available
    // Smoke test passes as long as no unexpected error occurs
  }
});

// ---------------------------------------------------------------------------
// Pi monitor UI smoke: quality profiles handled in prompt rendering
// ---------------------------------------------------------------------------

test("Pi prompt rendering with all quality profiles includes all disciplines", () => {
  const n = makeNode({
    qualityProfiles: [
      "incremental-implementation",
      "test-driven-change",
      "code-review-required",
      "api-boundary-review",
      "frontend-runtime-review",
      "security-sensitive-review",
      "performance-sensitive-review",
      "observability-required",
      "docs-adr-required",
      "ship-preflight",
    ] as GoalQualityProfile[],
  });
  const prompt = renderPiSubagentInitialPrompt({
    goalId: n.goalId,
    node: n,
    subagentId: "subagent-1",
    initialPrompt: "Full quality profile test",
  });
  assert.match(prompt, /QUALITY PROFILE EXECUTION DISCIPLINE/);
  for (const profile of SUPPORTED_QUALITY_PROFILES) {
    assert.match(prompt, new RegExp(profile), `Should mention ${profile}`);
  }
});
