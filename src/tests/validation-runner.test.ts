import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControllerValidationRunner, runControllerValidation, type GoalControllerValidationRequest } from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

function request(overrides: Partial<GoalControllerValidationRequest> = {}): GoalControllerValidationRequest {
  return {
    goalId: "goal-1",
    tickStartedAt: now,
    state: { goalId: "goal-1", nodes: [], subagents: [] },
    node: {
      goalId: "goal-1",
      nodeId: "build",
      slug: "build",
      objective: "Build feature",
      dependencyNodeIds: [],
      expectedOutputs: [],
      validators: [],
      completionGates: ["controller-validation"],
      status: "controllerValidating",
      createdAt: now,
      updatedAt: now,
    },
    subagent: {
      goalId: "goal-1",
      nodeId: "build",
      subagentId: "subagent-1",
      harnessAdapterId: "fake",
      status: "controllerValidating",
      prompts: ["initial"],
      createdAt: now,
      updatedAt: now,
    },
    ...overrides,
  };
}

test("controller validation runner fails skipped validators when explicitly disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-"));
  try {
    writeFileSync(join(dir, "README.md"), "ok\n");
    const result = runControllerValidation(
      request({
        node: { ...request().node, expectedOutputs: ["README.md"], validators: ["npm test"] },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
      { executeValidators: false },
    );

    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /skipped validators are not accepted/);
    assert.match(result.followupPrompt ?? "", /explicitly skipped by host policy/);
    assert.deepEqual(result.validationSignals, ["skipped validator by policy: npm test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner fails missing expected outputs with follow-up", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-"));
  try {
    const result = runControllerValidation(
      request({
        node: { ...request().node, expectedOutputs: ["missing.txt"] },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );

    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /missing outputs/);
    assert.match(result.followupPrompt ?? "", /missing.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner executes shell validators by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-"));
  try {
    const passing = runControllerValidation(
      request({
        node: { ...request().node, validators: ["printf validator-ok"] },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(passing.status, "passed");
    assert.match(passing.validationSignals?.[0] ?? "", /validator-ok/);

    const failing = await createControllerValidationRunner()(
      request({
        node: { ...request().node, validators: ["echo nope && exit 7"] },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(failing.status, "failed");
    assert.match(failing.followupPrompt ?? "", /echo nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner verifies locked validation artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-lock-"));
  try {
    const file = join(dir, "tests", "feature.test.ts");
    execFileSync("mkdir", ["-p", join(dir, "tests")]);
    writeFileSync(file, "assert true\n");
    const sha256 = createHash("sha256").update("assert true\n").digest("hex");

    const passing = runControllerValidation(
      request({
        node: {
          ...request().node,
          kind: "implementation",
          risk: "high",
          validation: {
            profile: "code-change",
            artifactLocks: [{ path: "tests/feature.test.ts", sha256 }],
            requiredEvidence: ["locked-artifacts-unchanged"],
          },
        },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
      { executeValidators: true },
    );
    assert.equal(passing.status, "passed");
    assert.match(passing.validationSignals?.join("\n") ?? "", /passed artifact lock/);

    writeFileSync(file, "assert false\n");
    const failing = runControllerValidation(
      request({
        node: {
          ...request().node,
          kind: "implementation",
          risk: "high",
          validation: {
            profile: "code-change",
            artifactLocks: [{ path: "tests/feature.test.ts", sha256 }],
            requiredEvidence: ["locked-artifacts-unchanged"],
          },
        },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
      { executeValidators: true },
    );
    assert.equal(failing.status, "failed");
    assert.match(failing.summary ?? "", /artifact locks changed or missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner rejects audit reports that still list remaining violations", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-audit-"));
  try {
    writeFileSync(join(dir, "report.md"), "# Audit\n\n9 violation paths / 98 files remain\n");
    const failing = runControllerValidation(
      request({
        node: {
          ...request().node,
          kind: "audit",
          validation: { requiredEvidence: ["audit-report-present"], auditReportPaths: ["report.md"] },
        },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(failing.status, "failed");
    assert.match(failing.summary ?? "", /missing evidence: audit-report-present/);

    writeFileSync(join(dir, "report.md"), "# Audit\n\n0 violations remain\n");
    const passing = runControllerValidation(
      request({
        node: {
          ...request().node,
          kind: "audit",
          validation: { requiredEvidence: ["audit-report-present"], auditReportPaths: ["report.md"] },
        },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(passing.status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner blocks high-risk implementation nodes without validation contract", () => {
  const result = runControllerValidation(
    request({
      node: { ...request().node, kind: "implementation", risk: "high" },
    }),
  );

  assert.equal(result.status, "failed");
  assert.match(result.summary ?? "", /high-risk implementation nodes require/);
});

test("controller validation runner checks required implementation diff evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-diff-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: dir });
    writeFileSync(join(dir, "src.ts"), "implementation\n");

    const result = runControllerValidation(
      request({
        node: {
          ...request().node,
          kind: "implementation",
          risk: "high",
          validation: {
            profile: "code-change",
            diffBaseRef: "base",
            requiredEvidence: ["implementation-diff-present", "non-test-diff-present"],
          },
        },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );

    assert.equal(result.status, "passed");
    assert.match(result.validationSignals?.join("\n") ?? "", /satisfied evidence: implementation-diff-present/);
    assert.match(result.validationSignals?.join("\n") ?? "", /satisfied evidence: non-test-diff-present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
