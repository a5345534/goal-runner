/**
 * Tests for the goal-runner model resolver:
 *   - User binding precedence (provided catalog beats bundled)
 *   - Candidate order (first-match-wins with attemptedCandidates index)
 *   - Switch events and exhausted chain in resolution evidence
 *   - bindingSource tracking
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveGoalModelForHarness,
  readBundledModelClassCatalog,
  type GoalModelResolutionRequest,
} from "../core/index.js";
import type {
  GoalModelBindingCatalog,
} from "goal-contract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal model class catalog with valid GoalModelClass shapes.
 */
const MINIMAL_CLASS_CATALOG = {
  version: 1 as const,
  modelClasses: {
    controller: {
      minimumRequirements: { reasoning: "high" as const, toolUse: "required" as const },
      fallbackPolicy: { allowDowngrade: true, onUnavailable: "block" as const },
    },
    implementation: {
      minimumRequirements: { reasoning: "high" as const },
      fallbackPolicy: { allowDowngrade: true, onUnavailable: "block" as const },
    },
    "strict-reviewer": {
      minimumRequirements: { reasoning: "very_high" as const, toolUse: "required" as const },
      fallbackPolicy: { allowDowngrade: true, onUnavailable: "block" as const },
    },
  },
};

const CUSTOM_BINDING_CATALOG: GoalModelBindingCatalog = {
  version: 2,
  harness: "pi",
  bindings: {
    implementation: {
      candidates: [
        { model: "openai-codex/gpt-5.3-codex-context", declaredCapabilities: { reasoning: "high" } },
        { model: "openai-codex/gpt-5.3-codex-spark", declaredCapabilities: { reasoning: "high" } },
      ],
    },
    controller: {
      candidates: [
        { model: "openai-codex/gpt-5.5", declaredCapabilities: { reasoning: "high", toolUse: "required" } },
      ],
    },
    "strict-reviewer": {
      candidates: [
        { model: "openai-codex/gpt-5.5", declaredCapabilities: { reasoning: "very_high", toolUse: "required" } },
        { model: "openai-codex/gpt-5.5-codex-code-review", declaredCapabilities: { reasoning: "very_high", toolUse: "required" } },
      ],
    },
  },
};

const PRECEDENCE_BINDING_CATALOG: GoalModelBindingCatalog = {
  version: 2,
  harness: "pi",
  bindings: {
    implementation: {
      candidates: [
        { model: "deepseek/deepseek-v4-flash", declaredCapabilities: { reasoning: "high" } },
      ],
    },
  },
};

function request(overrides: Partial<GoalModelResolutionRequest> = {}): GoalModelResolutionRequest {
  return {
    harness: "pi",
    modelClass: "implementation",
    classCatalog: MINIMAL_CLASS_CATALOG,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("resolver user-provided binding catalog takes precedence over bundled catalog", () => {
  const result = resolveGoalModelForHarness(
    request({ bindingCatalog: CUSTOM_BINDING_CATALOG, bindingSource: "user-provided-test" }),
  );
  assert.equal(result.modelArg, "openai-codex/gpt-5.3-codex-context");
  assert.equal(result.evidence.status, "resolved");
  assert.equal(result.evidence.resolved?.bindingSource, "user-provided-test");
});

test("resolver user-provided catalog overrides env-file and bundled sources", () => {
  const envBinding: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [{ model: "env-file-model", declaredCapabilities: { reasoning: "high" } }],
      },
    },
  };
  const result = resolveGoalModelForHarness(
    request({
      bindingCatalog: PRECEDENCE_BINDING_CATALOG,
      bindingSource: "explicit-precedence-test",
      env: { AGENT_GOAL_MODEL_BINDING_JSON: JSON.stringify(envBinding) },
    }),
  );
  assert.equal(result.modelArg, "deepseek/deepseek-v4-flash");
  assert.equal(result.evidence.resolved?.bindingSource, "explicit-precedence-test");
});

test("resolver candidate order follows first-match-wins from attemptedCandidates index 0", () => {
  const result = resolveGoalModelForHarness(
    request({ bindingCatalog: CUSTOM_BINDING_CATALOG, bindingSource: "candidate-order-test" }),
  );
  assert.equal(result.modelArg, "openai-codex/gpt-5.3-codex-context");
  assert.equal(result.evidence.resolved?.candidateIndex, 0);
  assert.ok(result.evidence.attemptedCandidates);
  assert.equal(result.evidence.attemptedCandidates.length, 1);
  assert.equal(result.evidence.attemptedCandidates[0]?.candidateIndex, 0);
  assert.equal(result.evidence.attemptedCandidates[0]?.model, "openai-codex/gpt-5.3-codex-context");
  assert.equal(result.evidence.attemptedCandidates[0]?.compliance.satisfiesMinimum, true);
});

test("resolver reports candidate index 1 when first candidate fails minimum", () => {
  const downgradeBinding: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [
          { model: "weak-model", declaredCapabilities: { reasoning: "low" } },
          { model: "strong-model", declaredCapabilities: { reasoning: "high" } },
        ],
      },
    },
  };
  const result = resolveGoalModelForHarness(
    request({ bindingCatalog: downgradeBinding, bindingSource: "fallback-order-test" }),
  );
  assert.equal(result.modelArg, "strong-model");
  assert.equal(result.evidence.resolved?.candidateIndex, 1);
  assert.ok(result.evidence.attemptedCandidates);
  assert.equal(result.evidence.attemptedCandidates.length, 2);
  assert.equal(result.evidence.attemptedCandidates[0]?.model, "weak-model");
  assert.equal(result.evidence.attemptedCandidates[0]?.compliance.satisfiesMinimum, false);
  assert.equal(result.evidence.attemptedCandidates[1]?.model, "strong-model");
  assert.equal(result.evidence.attemptedCandidates[1]?.compliance.satisfiesMinimum, true);
  assert.equal(result.evidence.status, "resolved");
});

test("resolver reports resolution evidence with switchEvents when fallback occurs", () => {
  const multiSwitchBinding: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [
          { model: "first-fail", declaredCapabilities: { reasoning: "low" } },
          { model: "second-fail", declaredCapabilities: { reasoning: "medium" } },
          { model: "third-pass", declaredCapabilities: { reasoning: "high" } },
        ],
      },
    },
  };
  const result = resolveGoalModelForHarness(
    request({ bindingCatalog: multiSwitchBinding, bindingSource: "switch-events-test" }),
  );
  assert.equal(result.modelArg, "third-pass");
  assert.equal(result.evidence.resolved?.candidateIndex, 2);
  assert.equal(result.evidence.status, "resolved");
  assert.ok(result.evidence.switchEvents);
  assert.equal(result.evidence.switchEvents.length, 2);
  assert.equal(result.evidence.switchEvents[0]?.fromCandidateIndex, 0);
  assert.equal(result.evidence.switchEvents[0]?.toCandidateIndex, 1);
  assert.equal(result.evidence.switchEvents[1]?.fromCandidateIndex, 1);
  assert.equal(result.evidence.switchEvents[1]?.toCandidateIndex, 2);
  // exhaustedChain is undefined (absent) when resolution succeeded
  assert.equal(result.evidence.exhaustedChain, undefined);
});

test("resolver blocks with exhaustedChain when all candidates fail minimum requirements", () => {
  const allFailBinding: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [
          { model: "fail-A", declaredCapabilities: { reasoning: "low" } },
          { model: "fail-B", declaredCapabilities: { reasoning: "medium" } },
        ],
      },
    },
  };
  assert.throws(
    () => resolveGoalModelForHarness(
      request({ bindingCatalog: allFailBinding, bindingSource: "exhausted-test" }),
    ),
    /all candidates exhausted/,
  );
  try {
    resolveGoalModelForHarness(
      request({ bindingCatalog: allFailBinding, bindingSource: "exhausted-test" }),
    );
    assert.fail("Expected error for exhausted chain");
  } catch (error: unknown) {
    const message = (error as Error).message;
    assert.match(message, /all candidates exhausted/);
  }
});

test("resolver bindingSource field correctly tracks where the binding came from", () => {
  const explicit = resolveGoalModelForHarness(
    request({ bindingCatalog: CUSTOM_BINDING_CATALOG, bindingSource: "explicit-catalog" }),
  );
  assert.equal(explicit.evidence.resolved?.bindingSource, "explicit-catalog");
  const envBinding: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [{ model: "env-model", declaredCapabilities: { reasoning: "high" } }],
      },
    },
  };
  const envJson = resolveGoalModelForHarness(
    request({ bindingCatalog: envBinding, bindingSource: "AGENT_GOAL_MODEL_BINDING_JSON", env: {} }),
  );
  assert.equal(envJson.evidence.resolved?.bindingSource, "AGENT_GOAL_MODEL_BINDING_JSON");
});

test("resolver strict-reviewer class resolves through pi harness", () => {
  const result = resolveGoalModelForHarness(
    request({ modelClass: "strict-reviewer", bindingCatalog: CUSTOM_BINDING_CATALOG, bindingSource: "strict-reviewer-test" }),
  );
  assert.equal(result.modelArg, "openai-codex/gpt-5.5");
  assert.equal(result.evidence.requested.modelClass, "strict-reviewer");
  assert.equal(result.evidence.resolved?.candidateIndex, 0);
  assert.equal(result.evidence.status, "resolved");
});

test("resolver uses bundled class catalog when no classCatalog provided and candidates satisfy minimum", () => {
  // The bundled model class catalog's "implementation" class requires:
  // reasoning:medium, contextWindowTokens:128000, toolUse:required, etc.
  const compatibleBinding: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [{
          model: "openai-codex/gpt-5.3-codex-spark",
          declaredCapabilities: {
            reasoning: "very_high",
            contextWindowTokens: 200000,
            toolUse: "required",
            structuredOutput: "strict",
            formatFollowing: "very_high",
            sourceCitation: "required",
            costSensitivity: "medium",
            privacy: "cloud-ok",
          },
        }],
      },
    },
  };
  const result = resolveGoalModelForHarness({
    harness: "pi",
    modelClass: "implementation",
    bindingCatalog: compatibleBinding,
    bindingSource: "bundled-class-test",
  });
  assert.equal(typeof result.modelArg, "string");
  assert.ok(result.modelArg.length > 0);
  assert.equal(result.evidence.status, "resolved");
});

test("resolver fails closed for unknown modelClass in provided catalog", () => {
  assert.throws(
    () => resolveGoalModelForHarness(request({ modelClass: "nonexistent-class", bindingCatalog: CUSTOM_BINDING_CATALOG, bindingSource: "unknown-class-test" })),
    /unknown modelClass/,
  );
});

test("resolver fails closed for harness mismatch in provided binding catalog", () => {
  const mismatchedCatalog: GoalModelBindingCatalog = {
    version: 2,
    harness: "opencode",
    bindings: {
      implementation: {
        candidates: [{ model: "opencode-model", declaredCapabilities: { reasoning: "high" } }],
      },
    },
  };
  assert.throws(
    () => resolveGoalModelForHarness(request({ bindingCatalog: mismatchedCatalog, bindingSource: "harness-mismatch-test" })),
    /does not match requested harness/,
  );
});

test("readBundledModelClassCatalog returns stable catalog", () => {
  const catalog = readBundledModelClassCatalog();
  assert.ok(catalog);
  assert.equal(catalog.version, 1);
  assert.ok(catalog.modelClasses);
  assert.ok(Object.keys(catalog.modelClasses).length > 0);
  assert.ok(catalog.modelClasses["implementation"]);
  assert.ok(catalog.modelClasses["controller"]);
});
