import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControllerValidationRunner, runControllerValidation } from "../core/index.js";
const now = "2026-06-02T00:00:00.000Z";
function request(overrides = {}) {
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
test("controller validation runner passes expected outputs and skipped validators by policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-validation-"));
    try {
        writeFileSync(join(dir, "README.md"), "ok\n");
        const result = runControllerValidation(request({
            node: { ...request().node, expectedOutputs: ["README.md"], validators: ["npm test"] },
            subagent: { ...request().subagent, workspacePath: dir },
        }), { executeValidators: false });
        assert.equal(result.status, "passed");
        assert.match(result.summary ?? "", /skipped 1 validator/);
        assert.deepEqual(result.validationSignals, ["skipped validator by policy: npm test"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("controller validation runner fails missing expected outputs with follow-up", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-validation-"));
    try {
        const result = runControllerValidation(request({
            node: { ...request().node, expectedOutputs: ["missing.txt"] },
            subagent: { ...request().subagent, workspacePath: dir },
        }));
        assert.equal(result.status, "failed");
        assert.match(result.summary ?? "", /missing outputs/);
        assert.match(result.followupPrompt ?? "", /missing.txt/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("controller validation runner can execute shell validators when explicitly enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-validation-"));
    try {
        const passing = runControllerValidation(request({
            node: { ...request().node, validators: ["printf validator-ok"] },
            subagent: { ...request().subagent, workspacePath: dir },
        }), { executeValidators: true });
        assert.equal(passing.status, "passed");
        assert.match(passing.validationSignals?.[0] ?? "", /validator-ok/);
        const failing = await createControllerValidationRunner({ executeValidators: true })(request({
            node: { ...request().node, validators: ["echo nope && exit 7"] },
            subagent: { ...request().subagent, workspacePath: dir },
        }));
        assert.equal(failing.status, "failed");
        assert.match(failing.followupPrompt ?? "", /echo nope/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=validation-runner.test.js.map