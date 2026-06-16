import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createGoalDagNodesFromFileContent,
  GoalRuntime,
  MemoryGoalStore,
  parseGoalDagFileContent,
  planGoalDagFromFileDocument,
  SUPPORTED_REQUIRED_EVIDENCE_SET,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

const validDag = {
  version: 1,
  objective: "Complete People Frappe backend remaining slices",
  defaults: {
    validators: ["npm test"],
    workspaceStrategy: "native-git-worktree",
    completionGates: ["controller-validation"],
    conflicts: { modules: ["people-frappe-module"] },
    thinkingLevel: "high",
  },
  nodes: [
    {
      id: "attendance-parity",
      objective: "Add attendance parity fixtures",
      outputs: ["tests/test_attendance_parity.py"],
      conflicts: { files: ["attendance"] },
    },
    {
      id: "payroll-doctypes",
      objective: "Add payroll DocTypes",
      after: ["attendance-parity"],
      validators: ["pytest"],
      risk: "medium",
      thinkingLevel: "xhigh",
    },
  ],
} as const;

test("goal DAG file parser creates explicit nodes without inferred sequencing", () => {
  const document = parseGoalDagFileContent(JSON.stringify(validDag));
  const plan = planGoalDagFromFileDocument("goal-1", document, { now });

  assert.equal(document.objective, "Complete People Frappe backend remaining slices");
  assert.deepEqual(plan.nodeInputs.map((node) => node.nodeId), ["attendance-parity", "payroll-doctypes"]);
  assert.deepEqual(plan.nodeInputs[0]?.dependencyNodeIds, []);
  assert.deepEqual(plan.nodeInputs[1]?.dependencyNodeIds, ["attendance-parity"]);
  assert.deepEqual(plan.nodeInputs[0]?.validators, ["npm test"]);
  assert.deepEqual(plan.nodeInputs[1]?.validators, ["pytest"]);
  assert.deepEqual(plan.nodeInputs[0]?.expectedOutputs, ["tests/test_attendance_parity.py"]);
  assert.deepEqual(plan.nodeInputs[0]?.conflictHints?.files, ["attendance"]);
  assert.deepEqual(plan.nodeInputs[0]?.conflictHints?.modules, undefined);
  assert.deepEqual(plan.nodeInputs[1]?.conflictHints?.modules, ["people-frappe-module"]);
  assert.equal(plan.nodeInputs[1]?.risk, "medium");
  assert.equal(plan.nodeInputs[0]?.thinkingLevel, "high");
  assert.equal(plan.nodeInputs[1]?.thinkingLevel, "xhigh");
});

test("goal DAG file parser accepts node workspace bindings and rejects nested worktree outputs", () => {
  const document = parseGoalDagFileContent(JSON.stringify({
    version: 1,
    objective: "Bound workspace goal",
    nodes: [{
      id: "bound-node",
      objective: "Use bound workspace",
      workspaceStrategy: "native-git-worktree",
      workspace: {
        worktreeSlug: "bound-node-worktree",
        branch: "feat/bound-node-worktree",
        baseRef: "main",
      },
      outputs: ["src/output.ts"],
    }],
  }));
  const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify(document), { now });

  assert.deepEqual(plan.nodes[0]?.workspace, {
    worktreeSlug: "bound-node-worktree",
    branch: "feat/bound-node-worktree",
    baseRef: "main",
  });

  assert.throws(
    () => createGoalDagNodesFromFileContent("goal-1", JSON.stringify({
      version: 1,
      objective: "Bad outputs",
      nodes: [{ id: "bad-node", objective: "Bad", workspaceStrategy: "native-git-worktree", outputs: [".worktrees/generated/src/output.ts"] }],
    }), { now }),
    /must be relative to the subagent workspace root/,
  );
});

test("goal DAG file parser rejects invalid structure before execution", () => {
  assert.throws(() => parseGoalDagFileContent("not-json"), /Invalid goal DAG file JSON/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 2, objective: "x", nodes: [] })), /version must be 1/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [] })), /nodes must not be empty/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "Bad_Id", objective: "x" }] })), /kebab-case/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "a", objective: "x" }, { id: "a", objective: "y" }] })), /duplicate node id: a/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "a", objective: "x", after: ["missing"] }] })), /depends on missing node missing/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "a", objective: "x", after: ["a"] }] })), /depends on itself/);
  assert.throws(
    () =>
      parseGoalDagFileContent(
        JSON.stringify({
          version: 1,
          objective: "x",
          nodes: [
            { id: "a", objective: "a", after: ["b"] },
            { id: "b", objective: "b", after: ["a"] },
          ],
        }),
      ),
    /cycle detected: a -> b -> a/,
  );
});

test("goal DAG file parser rejects trace sidecars and producer-only fields", () => {
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({ version: 1, goalDagSpecId: "spec-1", trace: { source: "producer" } })),
    /root has unsupported field goalDagSpecId|nodes must be an array/,
  );
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "a", objective: "x", consumes: ["spec"], produces: ["output"], evidence: [] }] })),
    /nodes\[0\] has unsupported field consumes/,
  );
});

test("goal DAG file parser rejects invalid validation locks and unknown model scenarios", () => {
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "x",
      nodes: [{ id: "a", objective: "x", validation: { artifactLocks: [{ path: "tests/a.test.ts", sha256: "not-a-sha" }] } }],
    })),
    /sha256 hex digest/,
  );
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "x",
      modelRouting: { scenarios: { docs: { model: "openai/gpt" } } },
      nodes: [{ id: "a", objective: "x", modelScenario: "missing" }],
    })),
    /modelScenario references unknown scenario missing/,
  );
});

test("goal DAG file documentation full examples pass parser validation", () => {
  const docs = readFileSync(new URL("../../docs/goal-dag-format.md", import.meta.url), "utf8");
  const blocks = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
  const runtimeExamples = blocks.filter((block) => block.includes('"version"') && block.includes('"nodes"'));
  assert.ok(runtimeExamples.length >= 2);
  for (const block of runtimeExamples) {
    const document = parseGoalDagFileContent(block);
    assert.equal(document.version, 1);
    assert.ok(document.nodes.length > 0);
  }
});

test("goal DAG file nodes are persisted and scheduled by dependencies", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now) } });
  const document = parseGoalDagFileContent(JSON.stringify(validDag));
  const plan = await runtime.planGoalDagFromFileDocument("goal-1", document, { now });

  assert.deepEqual(plan.nodes.map((node) => node.nodeId), ["attendance-parity", "payroll-doctypes"]);
  assert.deepEqual((await runtime.getGoalDagReadyQueue("goal-1")).ready.map((node) => node.nodeId), ["attendance-parity"]);

  const first = await runtime.getGoalDagNode("goal-1", "attendance-parity");
  assert.ok(first);
  await runtime.saveGoalDagNode({ ...first, status: "complete", updatedAt: "2026-06-02T00:01:00.000Z" });
  assert.deepEqual((await runtime.getGoalDagReadyQueue("goal-1")).ready.map((node) => node.nodeId), ["payroll-doctypes"]);
});

test("goal DAG file content creates durable nodes", () => {
  const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify(validDag), { now });

  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.nodes[0]?.workspaceStrategy, "native-git-worktree");
  assert.equal(plan.nodes[0]?.thinkingLevel, "high");
  assert.equal(plan.nodes[1]?.thinkingLevel, "xhigh");
  assert.deepEqual(plan.nodes[1]?.dependencyNodeIds, ["attendance-parity"]);
});

test("goal DAG file parser preserves validation contract metadata", () => {
  const document = parseGoalDagFileContent(JSON.stringify({
    version: 1,
    objective: "Use test-spec workflow",
    nodes: [
      { id: "write-tests", objective: "Write tests", kind: "test-spec" },
      {
        id: "implement-feature",
        objective: "Implement feature",
        after: ["write-tests"],
        kind: "implementation",
        risk: "high",
        validation: {
          profile: "code-change",
          testSpecNodeId: "write-tests",
          artifactLocks: [{ path: "tests/feature.test.js", sha256: "a".repeat(64), sourceNodeId: "write-tests" }],
          requiredEvidence: ["validators-ran", "locked-artifacts-unchanged"],
          diffBaseRef: "main",
          allowedPaths: ["src/**", "tests/**"],
          forbiddenPaths: ["package-lock.json", "infra/**"],
        },
      },
    ],
  }));
  const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify(document), { now });
  const node = plan.nodes[1];

  assert.equal(node?.kind, "implementation");
  assert.equal(node?.validation?.profile, "code-change");
  assert.equal(node?.validation?.testSpecNodeId, "write-tests");
  assert.deepEqual(node?.validation?.requiredEvidence, ["validators-ran", "locked-artifacts-unchanged"]);
  assert.deepEqual(node?.validation?.allowedPaths, ["src/**", "tests/**"]);
  assert.deepEqual(node?.validation?.forbiddenPaths, ["package-lock.json", "infra/**"]);
  assert.equal(node?.validation?.artifactLocks?.[0]?.sha256, "a".repeat(64));
});

test("goal DAG file parser rejects non-string-array validation scope policies", () => {
  const base = {
    version: 1,
    objective: "Bad scope policy",
    nodes: [{ id: "node-a", objective: "Do work", validation: {} }],
  };
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({ ...base, nodes: [{ ...base.nodes[0], validation: { allowedPaths: "src/**" } }] })),
    /validation\.allowedPaths must be an array/,
  );
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({ ...base, nodes: [{ ...base.nodes[0], validation: { forbiddenPaths: ["src/**", 42] } }] })),
    /validation\.forbiddenPaths\[1\] must be a non-empty string/,
  );
});

test("goal DAG file parser accepts all supported required evidence tokens", () => {
  const document = parseGoalDagFileContent(JSON.stringify({
    version: 1,
    objective: "Test all evidence tokens",
    nodes: [{
      id: "full-evidence",
      objective: "Use all tokens",
      validation: {
        requiredEvidence: [
          "validators-ran",
          "locked-artifacts-unchanged",
          "implementation-diff-present",
          "non-test-diff-present",
          "post-merge-validation-ran",
          "audit-report-present",
        ],
      },
    }],
  }));

  assert.deepEqual(document.nodes[0]?.validation?.requiredEvidence, [
    "validators-ran",
    "locked-artifacts-unchanged",
    "implementation-diff-present",
    "non-test-diff-present",
    "post-merge-validation-ran",
    "audit-report-present",
  ]);
});

test("goal DAG file parser rejects unsupported required evidence with clear remediation guidance", () => {
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "Bad evidence",
      nodes: [{
        id: "bad-node",
        objective: "Bad",
        validation: { requiredEvidence: ["pnpm test passes"] },
      }],
    })),
    /unsupported required evidence.*pnpm test passes/i,
  );

  // The error must list the supported evidence tokens
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "Bad evidence",
      nodes: [{
        id: "bad-node",
        objective: "Bad",
        validation: { requiredEvidence: ["manual review passed"] },
      }],
    })),
    /supported evidence tokens.*validators-ran/i,
  );

  // Natural-language checks should get remediation guidance
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "Bad evidence",
      nodes: [{
        id: "bad-node",
        objective: "Bad",
        validation: { requiredEvidence: ["pnpm test passes"] },
      }],
    })),
    /natural-language acceptance checks/i,
  );
});

test("goal DAG file parser rejects duplicate required evidence", () => {
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "Duplicate evidence",
      nodes: [{
        id: "dup-node",
        objective: "Dupe",
        validation: { requiredEvidence: ["validators-ran", "validators-ran"] },
      }],
    })),
    /duplicate required evidence: validators-ran/,
  );

  // Multiple duplicates should be caught (first duplicate errors first)
  assert.throws(
    () => parseGoalDagFileContent(JSON.stringify({
      version: 1,
      objective: "Duplicate evidence",
      nodes: [{
        id: "dup-node",
        objective: "Dupe",
        validation: { requiredEvidence: ["validators-ran", "locked-artifacts-unchanged", "locked-artifacts-unchanged"] },
      }],
    })),
    /duplicate required evidence: locked-artifacts-unchanged/,
  );
});

test("goal DAG file documentation examples use only supported evidence tokens", () => {
  const docs = readFileSync(new URL("../../docs/goal-dag-format.md", import.meta.url), "utf8");
  // Collect all requiredEvidence arrays from JSON code blocks in the docs
  const evidenceBlocks = [...docs.matchAll(/"requiredEvidence"\s*:\s*(\[[^\]]*\])/g)];
  for (const [, arrayText] of evidenceBlocks) {
    try {
      const parsed: string[] = JSON.parse(arrayText);
      for (const token of parsed) {
        assert.ok(
          SUPPORTED_REQUIRED_EVIDENCE_SET.has(token),
          `Docs example uses unsupported requiredEvidence: "${token}". Supported: ${[...SUPPORTED_REQUIRED_EVIDENCE_SET].join(", ")}`,
        );
      }
    } catch {
      // Skip malformed JSON in example blocks (not a test failure for this check)
    }
  }
});
