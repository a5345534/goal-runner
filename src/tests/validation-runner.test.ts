import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createControllerValidationRunner, runControllerValidation, type GoalControllerValidationRequest } from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

function initGitWorkspace(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
}

function initSubmoduleValidationWorkspace(prefix: string): { parent: string; submodule: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const source = join(root, "source");
  const parent = join(root, "parent");
  mkdirSync(source, { recursive: true });
  mkdirSync(parent, { recursive: true });
  initGitWorkspace(source);
  initGitWorkspace(parent);
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "aos-core"], { cwd: parent, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: join(parent, "aos-core") });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: join(parent, "aos-core") });
  execFileSync("git", ["add", ".gitmodules", "aos-core"], { cwd: parent });
  execFileSync("git", ["commit", "-m", "add submodule"], { cwd: parent, stdio: "ignore" });
  return { parent, submodule: join(parent, "aos-core") };
}

function commitSubmoduleChange(parent: string, submodule: string, relativePath: string, content: string): void {
  const fullPath = join(submodule, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", relativePath], { cwd: submodule });
  execFileSync("git", ["commit", "-m", `change ${relativePath}`], { cwd: submodule, stdio: "ignore" });
  execFileSync("git", ["add", "aos-core"], { cwd: parent });
  execFileSync("git", ["commit", "-m", "bump aos-core"], { cwd: parent, stdio: "ignore" });
}

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

test("controller validation runner accepts basename expected outputs from changed module paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-basename-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    mkdirSync(join(dir, "projects/backend/module/cost-collection-module/src/main/java/events"), { recursive: true });
    mkdirSync(join(dir, "other-module/src/main/java/events"), { recursive: true });
    const expectedPath = join(dir, "projects/backend/module/cost-collection-module/src/main/java/events/WorkflowExpenseEvent.java");
    writeFileSync(expectedPath, "class WorkflowExpenseEvent { int before; }\n");
    writeFileSync(join(dir, "other-module/src/main/java/events/WorkflowExpenseEvent.java"), "class WorkflowExpenseEvent {}\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
    writeFileSync(expectedPath, "class WorkflowExpenseEvent { int after; }\n");

    const result = runControllerValidation(
      request({
        node: { ...request().node, expectedOutputs: ["WorkflowExpenseEvent.java"] },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );

    assert.equal(result.status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner rejects ambiguous basename expected outputs without git evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-basename-ambiguous-"));
  try {
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a", "Duplicate.java"), "class Duplicate {}\n");
    writeFileSync(join(dir, "b", "Duplicate.java"), "class Duplicate {}\n");

    const result = runControllerValidation(
      request({
        node: { ...request().node, expectedOutputs: ["Duplicate.java"] },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );

    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /missing outputs: Duplicate\.java/);
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

test("controller validation runner enforces validation allowed paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-scope-allowed-"));
  try {
    initGitWorkspace(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "feature.ts"), "export const ok = true;\n");

    const passing = runControllerValidation(
      request({
        node: { ...request().node, validation: { allowedPaths: ["src/**"] } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(passing.status, "passed");
    assert.match(passing.validationSignals?.join("\n") ?? "", /scope policy passed/);

    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra", "deploy.yml"), "bad: true\n");
    const failing = runControllerValidation(
      request({
        node: { ...request().node, validation: { allowedPaths: ["src/**"] } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(failing.status, "failed");
    assert.match(failing.summary ?? "", /changed files outside allowed paths: infra\/deploy\.yml/);
    assert.match(failing.followupPrompt ?? "", /Do not expand scope/);
    assert.match(failing.followupPrompt ?? "", /infra\/deploy\.yml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner enforces validation scope for committed native-git diffs without validation diffBaseRef", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-scope-committed-"));
  try {
    initGitWorkspace(dir);
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra", "deploy.yml"), "bad: true\n");
    execFileSync("git", ["add", "infra/deploy.yml"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "commit forbidden file"], { cwd: dir, stdio: "ignore" });

    const result = runControllerValidation(
      request({
        node: { ...request().node, workspace: { baseRef: "HEAD~1" }, validation: { allowedPaths: ["src/**"], forbiddenPaths: ["infra/**"] } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /changed files touched forbidden paths: infra\/deploy\.yml/);
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: dir, encoding: "utf8" }).trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner accepts changed submodule gitlink when internal diff maps to allowed paths", () => {
  const { parent, submodule } = initSubmoduleValidationWorkspace("goal-validation-submodule-allowed-");
  try {
    commitSubmoduleChange(parent, submodule, "packages/runtime-ports/src/index.ts", "export const ok = true;\n");

    const result = runControllerValidation(
      request({
        node: {
          ...request().node,
          workspace: { baseRef: "HEAD~1" },
          validation: { allowedPaths: ["aos-core/packages/runtime-ports/**"] },
        },
        subagent: { ...request().subagent, workspacePath: parent },
      }),
    );

    assert.equal(result.status, "passed");
    assert.match(result.validationSignals?.join("\n") ?? "", /scope policy passed/);
  } finally {
    rmSync(dirname(parent), { recursive: true, force: true });
  }
});

test("controller validation runner rejects changed submodule gitlink when internal diff is outside allowed paths", () => {
  const { parent, submodule } = initSubmoduleValidationWorkspace("goal-validation-submodule-outside-");
  try {
    commitSubmoduleChange(parent, submodule, "packages/domain-adapters/src/index.ts", "export const adapter = true;\n");

    const result = runControllerValidation(
      request({
        node: {
          ...request().node,
          workspace: { baseRef: "HEAD~1" },
          validation: { allowedPaths: ["aos-core/packages/runtime-ports/**"] },
        },
        subagent: { ...request().subagent, workspacePath: parent },
      }),
    );

    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /changed files outside allowed paths: aos-core\/packages\/domain-adapters\/src\/index\.ts/);
    assert.doesNotMatch(result.summary ?? "", /changed files outside allowed paths: aos-core(,|$|;)/);
  } finally {
    rmSync(dirname(parent), { recursive: true, force: true });
  }
});

test("controller validation runner applies forbidden paths to mapped submodule internal diff", () => {
  const { parent, submodule } = initSubmoduleValidationWorkspace("goal-validation-submodule-forbidden-");
  try {
    commitSubmoduleChange(parent, submodule, "apps/api/src/main.ts", "export const forbidden = true;\n");

    const result = runControllerValidation(
      request({
        node: {
          ...request().node,
          workspace: { baseRef: "HEAD~1" },
          validation: { allowedPaths: ["aos-core/packages/**", "aos-core/apps/**"], forbiddenPaths: ["aos-core/apps/**"] },
        },
        subagent: { ...request().subagent, workspacePath: parent },
      }),
    );

    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /changed files touched forbidden paths: aos-core\/apps\/api\/src\/main\.ts/);
  } finally {
    rmSync(dirname(parent), { recursive: true, force: true });
  }
});

test("controller validation runner initializes missing submodule worktree before internal diff", () => {
  const { parent, submodule } = initSubmoduleValidationWorkspace("goal-validation-submodule-init-");
  try {
    commitSubmoduleChange(parent, submodule, "packages/runtime-ports/src/index.ts", "export const ok = true;\n");
    rmSync(submodule, { recursive: true, force: true });

    const result = runControllerValidation(
      request({
        node: {
          ...request().node,
          workspace: { baseRef: "HEAD~1" },
          validation: { allowedPaths: ["aos-core/packages/runtime-ports/**"] },
        },
        subagent: { ...request().subagent, workspacePath: parent },
      }),
    );

    assert.equal(result.status, "passed");
    assert.match(result.validationSignals?.join("\n") ?? "", /scope policy passed/);
  } finally {
    rmSync(dirname(parent), { recursive: true, force: true });
  }
});

test("controller validation runner fails closed when changed submodule gitlink diff cannot be inspected", () => {
  const { parent, submodule } = initSubmoduleValidationWorkspace("goal-validation-submodule-missing-");
  try {
    commitSubmoduleChange(parent, submodule, "packages/runtime-ports/src/index.ts", "export const ok = true;\n");
    rmSync(submodule, { recursive: true, force: true });
    rmSync(join(parent, ".git", "modules", "aos-core"), { recursive: true, force: true });

    const result = runControllerValidation(
      request({
        node: {
          ...request().node,
          workspace: { baseRef: "HEAD~1" },
          validation: { allowedPaths: ["aos-core/packages/runtime-ports/**"] },
        },
        subagent: { ...request().subagent, workspacePath: parent },
      }),
    );

    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /changed submodule gitlink aos-core cannot be validated/);
    assert.match(result.summary ?? "", /missing commit\(s\)|not initialized/);
  } finally {
    rmSync(dirname(parent), { recursive: true, force: true });
  }
});

test("controller validation runner treats rename sources as touched paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-scope-rename-"));
  try {
    initGitWorkspace(dir);
    mkdirSync(join(dir, "src", "secrets"), { recursive: true });
    writeFileSync(join(dir, "src", "secrets", "key.ts"), "export const secret = true;\n");
    execFileSync("git", ["add", "src/secrets/key.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add secret"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src", "public"), { recursive: true });
    execFileSync("git", ["mv", "src/secrets/key.ts", "src/public/key.ts"], { cwd: dir });

    const result = runControllerValidation(
      request({
        node: { ...request().node, validation: { allowedPaths: ["src/**"], forbiddenPaths: ["src/secrets/**"] } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /changed files touched forbidden paths: src\/secrets\/key\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner enforces validation forbidden paths before allowed paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-scope-forbidden-"));
  try {
    initGitWorkspace(dir);
    mkdirSync(join(dir, "src", "secrets"), { recursive: true });
    writeFileSync(join(dir, "src", "secrets", "key.ts"), "export const secret = true;\n");
    writeFileSync(join(dir, "package-lock.json"), "{}\n");

    const result = runControllerValidation(
      request({
        node: { ...request().node, validation: { allowedPaths: ["src/**"], forbiddenPaths: ["src/secrets/**", "package-lock.json"] } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /changed files touched forbidden paths: .*package-lock\.json/);
    assert.match(result.summary ?? "", /src\/secrets\/key\.ts/);
    assert.doesNotMatch(result.summary ?? "", /changed files outside allowed paths: src\/secrets\/key\.ts/);
    assert.match(result.followupPrompt ?? "", /package-lock\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner preserves behavior without validation scope policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-no-scope-"));
  try {
    initGitWorkspace(dir);
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra", "deploy.yml"), "allowed by absence of policy\n");

    const result = runControllerValidation(
      request({
        node: { ...request().node, validation: { profile: "code-change" } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(result.status, "passed");
    assert.doesNotMatch(result.validationSignals?.join("\n") ?? "", /scope policy passed|policy failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller validation runner defers post-merge evidence to integration", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-post-merge-evidence-"));
  try {
    initGitWorkspace(dir);
    const result = runControllerValidation(
      request({
        node: { ...request().node, validators: ["true"], validation: { requiredEvidence: ["post-merge-validation-ran"] } },
        subagent: { ...request().subagent, workspacePath: dir },
      }),
    );
    assert.equal(result.status, "passed");
    assert.doesNotMatch(result.validationSignals?.join("\n") ?? "", /satisfied evidence: post-merge-validation-ran/);
    assert.doesNotMatch(result.validationSignals?.join("\n") ?? "", /missing evidence: post-merge-validation-ran/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("controller validation runner blocks persisted unsupported required evidence without follow-up", () => {
  // Simulate old persisted state with unsupported evidence tokens.
  // The closed TypeScript union prevents assigning invalid strings, so we
  // mutate the returned mutable request object to bypass the type guard.
  const req = request({
    node: {
      ...request().node,
      validation: {} as never,
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req.node.validation as any).requiredEvidence = ["pnpm test passes"];
  const result = runControllerValidation(req);

  assert.equal(result.status, "blocked");
  assert.ok(!result.followupPrompt, "must not include followupPrompt for invalid contract");
  assert.match(result.summary ?? "", /unsupported requiredEvidence token\(s\): pnpm test passes/);
  assert.match(result.summary ?? "", /invalid validation contract/i);
  // Validation signals should include diagnostic info about the unsupported token
  assert.match(
    result.validationSignals?.join("\n") ?? "",
    /invalid contract: unsupported required evidence: pnpm test passes/,
  );
});

test("controller validation runner blocks multiple persisted unsupported evidence tokens together", () => {
  const req = request({
    node: {
      ...request().node,
      validation: {} as never,
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req.node.validation as any).requiredEvidence = ["manual review passed", "lint ok"];
  const result = runControllerValidation(req);

  assert.equal(result.status, "blocked");
  assert.ok(!result.followupPrompt, "must not include followupPrompt");
  // Both unsupported tokens should appear in diagnostics
  assert.match(result.summary ?? "", /manual review passed/);
  assert.match(result.summary ?? "", /lint ok/);
  // Should list supported evidence tokens for remediation
  assert.match(result.summary ?? "", /supported evidence tokens/i);
  assert.match(result.summary ?? "", /validators-ran/);
});

test("controller validation runner rejects unsupported evidence as high-risk implementation coverage", () => {
  // High-risk implementation node with ONLY unsupported evidence and no other validation.
  // The unsupported-evidence guard must fire before high-risk policy check.
  const req = request({
    node: {
      ...request().node,
      kind: "implementation",
      risk: "high",
      validation: {} as never,
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req.node.validation as any).requiredEvidence = ["manual review passed"];
  const result = runControllerValidation(req);

  // The unsupported evidence guard fires first, returning blocked
  assert.equal(result.status, "blocked");
  assert.match(result.summary ?? "", /unsupported requiredEvidence token/);
  // Since unsupported-evidence guard runs before high-risk policy check,
  // the blocked result must not also contain the high-risk policy failure message
  assert.doesNotMatch(result.summary ?? "", /high-risk implementation nodes require/);
});

test("controller validation runner does not treat unsupported evidence as valid high-risk coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-validation-highrisk-unsupported-"));
  try {
    // High-risk implementation node with supported evidence alongside unsupported.
    // The unsupported evidence should still trigger blocking regardless of supported evidence.
    const req = request({
      node: {
        ...request().node,
        kind: "implementation",
        risk: "high",
        validators: ["true"],
        validation: {} as never,
      },
      subagent: {
        ...request().subagent,
        workspacePath: dir,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req.node.validation as any).requiredEvidence = ["validators-ran", "pnpm test passes"];
    const result = runControllerValidation(req);

    // Even with a supported evidence token present, unsupported ones must still cause blocking
    assert.equal(result.status, "blocked");
    assert.match(result.summary ?? "", /unsupported requiredEvidence token/);
    assert.ok(!result.followupPrompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
