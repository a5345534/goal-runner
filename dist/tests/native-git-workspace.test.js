import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSubagentWorkspace, cleanupTerminalSubagentWorkspaces, createNativeGitSubagentBranchIntegrator, createNativeGitSubagentWorkspaceAllocator, findGitRepositoryRoot, GoalRuntime, MemoryGoalStore, NativeGitWorkspaceManager, slugForGoal, slugForGoalSubagent, } from "../core/index.js";
function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function createRepo() {
    const repo = mkdtempSync(join(tmpdir(), "goal-native-git-"));
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "goal@example.test"]);
    git(repo, ["config", "user.name", "Goal Test"]);
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    return repo;
}
function integrationNode(overrides = {}) {
    return {
        goalId: "goal-abcdef12",
        nodeId: "post-merge",
        slug: "post-merge",
        objective: "Integrate feature",
        dependencyNodeIds: [],
        expectedOutputs: ["feature.txt"],
        validators: ["test -f feature.txt"],
        completionGates: ["controller-validation", "native-git-integration"],
        status: "controllerValidating",
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
        ...overrides,
    };
}
test("native git manager auto-allocates a controller worktree and branch", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateControllerWorkspace({
            invocationCwd: repo,
            goalId: "7dfb3e07-a26a-441f-aa5c-056b486520f7",
            objective: "Finish People Frappe backend",
        });
        assert.equal(allocation.repoRoot, repo);
        assert.equal(allocation.baseRef, "main");
        assert.equal(allocation.allocationReason, "workspace-and-branch-omitted");
        assert.match(allocation.slug, /^7dfb3e07-finish-people-frappe-backend/);
        assert.equal(git(allocation.worktreePath, ["branch", "--show-current"]), allocation.branch);
        assert.equal(git(repo, ["branch", "--show-current"]), "main");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        assert.equal(existsSync(allocation.worktreePath), false);
        assert.throws(() => git(repo, ["show-ref", "--verify", `refs/heads/${allocation.branch}`]));
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git manager rejects missing explicit controller base refs before worktree add", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "feat/missing", fetch: false });
        assert.throws(() => manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-missing-base", objective: "Implement missing base" }), /cannot resolve goal workspace base ref: feat\/missing is not a commit-ish ref/);
        assert.equal(git(repo, ["worktree", "list", "--porcelain"]).includes("goal-missing-base"), false);
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git manager resolves slug collisions without reusing branches", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const request = { invocationCwd: repo, goalId: "goal-12345678", objective: "Add DAG planner" };
        const first = manager.allocateControllerWorkspace(request);
        const second = manager.allocateControllerWorkspace(request);
        assert.notEqual(first.slug, second.slug);
        assert.notEqual(first.branch, second.branch);
        assert.ok(second.slug.endsWith("-2"));
        assert.equal(git(second.worktreePath, ["branch", "--show-current"]), second.branch);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: first.worktreePath, branch: first.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: second.worktreePath, branch: second.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git manager allocates subagent worktrees from a controller branch", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({
            invocationCwd: repo,
            goalId: "goal-abcdef12",
            objective: "Controller workspace",
        });
        const allocation = manager.allocateSubagentWorkspace({
            invocationCwd: repo,
            controllerWorkspacePath: controller.worktreePath,
            goalId: "goal-abcdef12",
            nodeId: "attendance-doctypes",
            nodeSlug: "attendance-doctypes",
            nodeObjective: "Implement attendance doctypes",
        });
        assert.equal(allocation.repoRoot, repo);
        assert.equal(allocation.baseRef, controller.branch);
        assert.equal(allocation.allocationReason, "subagent-dag-node");
        assert.equal(allocation.nodeId, "attendance-doctypes");
        assert.match(allocation.subagentId, /^subagent-goal-abc-attendance-doctypes/);
        assert.equal(git(allocation.worktreePath, ["branch", "--show-current"]), allocation.branch);
        assert.equal(git(controller.worktreePath, ["branch", "--show-current"]), controller.branch);
        assert.equal(git(repo, ["branch", "--show-current"]), "main");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git manager honors deterministic subagent workspace binding", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({
            invocationCwd: repo,
            goalId: "goal-abcdef12",
            nodeId: "bound-node",
            worktreeSlug: "bound-node-worktree",
            branch: "feat/bound-node-worktree",
        });
        assert.equal(allocation.slug, "bound-node-worktree");
        assert.equal(allocation.branch, "feat/bound-node-worktree");
        assert.equal(allocation.worktreePath, join(repo, ".worktrees", "bound-node-worktree"));
        assert.equal(allocation.created, true);
        assert.equal(git(allocation.worktreePath, ["branch", "--show-current"]), "feat/bound-node-worktree");
        const reused = manager.allocateSubagentWorkspace({
            invocationCwd: repo,
            goalId: "goal-abcdef12",
            nodeId: "bound-node",
            worktreeSlug: "bound-node-worktree",
            branch: "feat/bound-node-worktree",
        });
        assert.equal(reused.worktreePath, allocation.worktreePath);
        assert.equal(reused.created, false);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git manager rejects dirty deterministic subagent workspace reuse", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", nodeId: "bound-node", worktreeSlug: "bound-node-worktree", branch: "feat/bound-node-worktree" });
        writeFileSync(join(allocation.worktreePath, "dirty.txt"), "dirty\n");
        assert.throws(() => manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", nodeId: "bound-node", worktreeSlug: "bound-node-worktree", branch: "feat/bound-node-worktree" }), /uncommitted changes/);
        rmSync(join(allocation.worktreePath, "dirty.txt"), { force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git subagent allocator uses DAG node workspace binding", async () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date("2026-06-02T00:00:00.000Z") } });
        await runtime.planGoalDag("goal-abcdef12", [{
                nodeId: "attendance",
                objective: "Implement attendance",
                workspace: { worktreeSlug: "attendance-bound", branch: "feat/attendance-bound", baseRef: "main" },
            }], { now: "2026-06-02T00:00:00.000Z" });
        const starts = [];
        const adapter = {
            adapterId: "fake",
            startSession(request) {
                starts.push(request);
                return { sessionId: `session-${request.subagentId}`, status: "running", workspacePath: request.cwd, branch: request.branch };
            },
            sendPrompt() { },
            getSessionState() {
                return { status: "running" };
            },
            abortSession() { },
        };
        const tick = await runtime.runGoalControllerTick("goal-abcdef12", {
            adapter,
            workspaceAllocator: createNativeGitSubagentWorkspaceAllocator(manager, { invocationCwd: repo }),
        });
        assert.equal(tick.started.length, 1);
        assert.equal(starts[0]?.cwd, join(repo, ".worktrees", "attendance-bound"));
        assert.equal(starts[0]?.branch, "feat/attendance-bound");
        assert.equal(git(starts[0]?.cwd ?? repo, ["branch", "--show-current"]), "feat/attendance-bound");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: starts[0]?.cwd ?? "", branch: starts[0]?.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git manager resolves subagent worktree collisions", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const request = {
            invocationCwd: repo,
            goalId: "goal-abcdef12",
            nodeId: "attendance-doctypes",
            nodeSlug: "attendance-doctypes",
            nodeObjective: "Implement attendance doctypes",
        };
        const first = manager.allocateSubagentWorkspace(request);
        const second = manager.allocateSubagentWorkspace(request);
        assert.notEqual(first.slug, second.slug);
        assert.notEqual(first.branch, second.branch);
        assert.ok(second.slug.endsWith("-2"));
        assert.ok(second.subagentId.endsWith("-2"));
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: first.worktreePath, branch: first.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: second.worktreePath, branch: second.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git subagent allocator plugs into controller loop workspace allocation", async () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date("2026-06-02T00:00:00.000Z") } });
        await runtime.planGoalDag("goal-abcdef12", [{ nodeId: "attendance", objective: "Implement attendance" }], {
            now: "2026-06-02T00:00:00.000Z",
        });
        const starts = [];
        const adapter = {
            adapterId: "fake",
            startSession(request) {
                starts.push(request);
                return { sessionId: `session-${request.subagentId}`, status: "running", workspacePath: request.cwd, branch: request.branch };
            },
            sendPrompt() { },
            getSessionState() {
                return { status: "running" };
            },
            abortSession() { },
        };
        const tick = await runtime.runGoalControllerTick("goal-abcdef12", {
            adapter,
            workspaceAllocator: createNativeGitSubagentWorkspaceAllocator(manager, { invocationCwd: repo, baseRef: "main" }),
        });
        assert.equal(tick.started.length, 1);
        assert.equal(starts.length, 1);
        assert.ok(starts[0]?.cwd);
        assert.equal(git(starts[0]?.cwd ?? repo, ["branch", "--show-current"]), starts[0]?.branch);
        assert.match(starts[0]?.branch ?? "", /^goal\/goal-abcdef1\/goal-abc-implement-attendance/);
        assert.equal((await runtime.getGoalSubagent("goal-abcdef12", tick.started[0]?.subagentId ?? ""))?.workspacePath, starts[0]?.cwd);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: starts[0]?.cwd ?? "", branch: starts[0]?.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup policy removes completed subagent worktrees and preserves blocked ones", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const complete = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", nodeId: "complete-node" });
        const blocked = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", nodeId: "blocked-node" });
        const subagents = [
            {
                goalId: "goal-abcdef12",
                nodeId: "complete-node",
                subagentId: complete.subagentId,
                harnessAdapterId: "fake",
                workspacePath: complete.worktreePath,
                branch: complete.branch,
                status: "complete",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
            {
                goalId: "goal-abcdef12",
                nodeId: "blocked-node",
                subagentId: blocked.subagentId,
                harnessAdapterId: "fake",
                workspacePath: blocked.worktreePath,
                branch: blocked.branch,
                status: "blocked",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        ];
        const results = cleanupTerminalSubagentWorkspaces(manager, { goalId: "goal-abcdef12", nodes: [], subagents }, { force: true });
        assert.deepEqual(results.map((item) => [item.nodeId, item.action]), [
            ["complete-node", "removed"],
            ["blocked-node", "preserved"],
        ]);
        assert.equal(existsSync(complete.worktreePath), false);
        assert.equal(existsSync(blocked.worktreePath), true);
        assert.throws(() => git(repo, ["show-ref", "--verify", `refs/heads/${complete.branch}`]));
        assert.equal(git(blocked.worktreePath, ["branch", "--show-current"]), blocked.branch);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: blocked.worktreePath, branch: blocked.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup force-deletes only after integration and promotion pass", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-cleanup", nodeId: "complete-node" });
        writeFileSync(join(allocation.worktreePath, "scratch.txt"), "untracked scratch\n");
        const sourceHead = git(allocation.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        const subagent = {
            goalId: "goal-cleanup",
            nodeId: "complete-node",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            workspacePath: allocation.worktreePath,
            branch: allocation.branch,
            status: "complete",
            prompts: [],
            integrationState: "complete",
            integrationSourceHead: sourceHead,
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const result = cleanupSubagentWorkspace(manager, subagent, { force: true, promotionStatus: "complete", verifySourceReachable: true });
        assert.equal(result.action, "removed");
        assert.equal(result.forceAuthorized, true);
        assert.equal(result.forceReason, "force-delete authorized");
        assert.equal(result.reachabilityVerified, true);
        assert.equal(existsSync(allocation.worktreePath), false);
        assert.throws(() => git(repo, ["show-ref", "--verify", `refs/heads/${allocation.branch}`]));
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup refuses force delete without integrator-confirmed integration", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-cleanup", nodeId: "legacy-not-required" });
        const subagent = {
            goalId: "goal-cleanup",
            nodeId: "legacy-not-required",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            workspacePath: allocation.worktreePath,
            branch: allocation.branch,
            status: "complete",
            prompts: [],
            integrationState: "not-required",
            integrationStatus: "integration not required",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const result = cleanupSubagentWorkspace(manager, subagent, { force: true, promotionStatus: "complete" });
        assert.equal(result.action, "removed");
        assert.equal(result.forceAuthorized, false);
        assert.match(result.forceReason ?? "", /without terminal integration state/);
        assert.equal(existsSync(allocation.worktreePath), false);
        assert.throws(() => git(repo, ["show-ref", "--verify", `refs/heads/${allocation.branch}`]));
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup preserves force delete safety when promotion is blocked", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-cleanup", nodeId: "blocked-promotion" });
        const sourceHead = git(allocation.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        const subagent = {
            goalId: "goal-cleanup",
            nodeId: "blocked-promotion",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            workspacePath: allocation.worktreePath,
            branch: allocation.branch,
            status: "complete",
            prompts: [],
            integrationState: "complete",
            integrationSourceHead: sourceHead,
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const result = cleanupSubagentWorkspace(manager, subagent, { force: true, promotionStatus: "blocked" });
        assert.equal(result.action, "removed");
        assert.equal(result.forceAuthorized, false);
        assert.match(result.forceReason ?? "", /promotion passed/);
        assert.equal(existsSync(allocation.worktreePath), false);
        assert.throws(() => git(repo, ["show-ref", "--verify", `refs/heads/${allocation.branch}`]));
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup blocks force delete when source SHA is unreachable", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-cleanup", nodeId: "unreachable-source" });
        const subagent = {
            goalId: "goal-cleanup",
            nodeId: "unreachable-source",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            workspacePath: allocation.worktreePath,
            branch: allocation.branch,
            status: "complete",
            prompts: [],
            integrationState: "complete",
            integrationSourceHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const result = cleanupSubagentWorkspace(manager, subagent, { force: true, promotionStatus: "complete", verifySourceReachable: true });
        assert.equal(result.action, "error");
        assert.equal(result.forceAuthorized, true);
        assert.match(result.error ?? "", /not reachable/);
        assert.equal(existsSync(allocation.worktreePath), true);
        assert.doesNotThrow(() => git(repo, ["show-ref", "--verify", `refs/heads/${allocation.branch}`]));
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup can use controller-owned prepared resource records", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-prepared", nodeId: "prepared-node" });
        const node = {
            goalId: "goal-prepared",
            nodeId: "prepared-node",
            slug: "prepared-node",
            objective: "Prepared cleanup",
            dependencyNodeIds: [],
            expectedOutputs: [],
            validators: [],
            completionGates: ["controller-validation"],
            status: "complete",
            lifecyclePhase: "terminal",
            preparedResources: {
                subagentId: allocation.subagentId,
                adapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const subagent = {
            goalId: "goal-prepared",
            nodeId: "prepared-node",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            status: "complete",
            prompts: [],
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const [result] = cleanupTerminalSubagentWorkspaces(manager, { goalId: "goal-prepared", nodes: [node], subagents: [subagent] }, { force: true });
        assert.equal(result?.action, "removed");
        assert.equal(result?.workspacePath, allocation.worktreePath);
        assert.equal(existsSync(allocation.worktreePath), false);
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git promotion merges controller branch into target branch before closeout", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({
            invocationCwd: repo,
            goalId: "goal-promote1",
            objective: "Promote controller branch",
        });
        writeFileSync(join(controller.worktreePath, "feature.txt"), "done\n");
        git(controller.worktreePath, ["add", "feature.txt"]);
        git(controller.worktreePath, ["commit", "-m", "feat: controller work"]);
        const controllerHead = git(controller.worktreePath, ["rev-parse", "HEAD"]);
        const result = manager.promoteControllerBranch({
            controllerWorkspacePath: controller.worktreePath,
            controllerBranch: controller.branch,
            targetRef: controller.baseRef,
        });
        assert.equal(result.status, "complete");
        assert.equal(result.targetBranch, "main");
        assert.equal(git(repo, ["branch", "--show-current"]), "main");
        assert.equal(git(repo, ["show", "HEAD:feature.txt"]), "done");
        assert.doesNotThrow(() => git(repo, ["merge-base", "--is-ancestor", controllerHead, "HEAD"]));
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git promotion blocks dirty target worktrees", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({
            invocationCwd: repo,
            goalId: "goal-promote2",
            objective: "Promote dirty target",
        });
        writeFileSync(join(controller.worktreePath, "feature.txt"), "done\n");
        git(controller.worktreePath, ["add", "feature.txt"]);
        git(controller.worktreePath, ["commit", "-m", "feat: controller work"]);
        writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
        const result = manager.promoteControllerBranch({
            controllerWorkspacePath: controller.worktreePath,
            controllerBranch: controller.branch,
            targetRef: controller.baseRef,
        });
        assert.equal(result.status, "blocked");
        assert.match(result.summary, /target workspace has uncommitted changes/);
        assert.throws(() => git(repo, ["show", "HEAD:feature.txt"]));
        assert.equal(existsSync(controller.worktreePath), true);
        rmSync(join(repo, "dirty.txt"), { force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git promotion aborts merge conflicts and blocks completion", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({
            invocationCwd: repo,
            goalId: "goal-promote3",
            objective: "Promote conflicting target",
        });
        writeFileSync(join(repo, "conflict.txt"), "target\n");
        git(repo, ["add", "conflict.txt"]);
        git(repo, ["commit", "-m", "feat: target change"]);
        writeFileSync(join(controller.worktreePath, "conflict.txt"), "controller\n");
        git(controller.worktreePath, ["add", "conflict.txt"]);
        git(controller.worktreePath, ["commit", "-m", "feat: controller change"]);
        const result = manager.promoteControllerBranch({
            controllerWorkspacePath: controller.worktreePath,
            controllerBranch: controller.branch,
            targetRef: controller.baseRef,
        });
        assert.equal(result.status, "blocked");
        assert.match(result.summary, /git merge failed while promoting controller branch/);
        assert.equal(git(repo, ["diff", "--name-only", "--diff-filter=U"]), "");
        assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=no"]), "");
        assert.equal(git(repo, ["show", "HEAD:conflict.txt"]), "target");
        assert.equal(existsSync(controller.worktreePath), true);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git cleanup policy can remove blocked worktrees when explicitly requested", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", nodeId: "blocked-node" });
        const subagent = {
            goalId: "goal-abcdef12",
            nodeId: "blocked-node",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            workspacePath: allocation.worktreePath,
            branch: allocation.branch,
            status: "blocked",
            prompts: [],
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
        };
        const [result] = cleanupTerminalSubagentWorkspaces(manager, { goalId: "goal-abcdef12", nodes: [], subagents: [subagent] }, { blocked: "remove", force: true });
        assert.equal(result?.action, "removed");
        assert.equal(existsSync(allocation.worktreePath), false);
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator merges committed subagent branch into controller workspace", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "build" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const sourceHead = git(allocation.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "build",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "complete");
        assert.equal(result.sourceHead, sourceHead);
        assert.equal(git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]), result.integrationCommitSha);
        assert.equal(git(controller.worktreePath, ["show", "HEAD:feature.txt"]), "implemented");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator normalizes post-merge gate names before committing integration", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "post-merge" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            node: integrationNode({ completionGates: ["controller-validation", "native-git-integration", "post_merge_validation"] }),
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "post-merge",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "complete");
        assert.match(result.summary, /post-merge validation passed/);
        assert.match(result.validationSignals?.join("\n") ?? "", /post-merge validator passed: test -f feature\.txt/);
        assert.equal(git(controller.worktreePath, ["show", "HEAD:feature.txt"]), "implemented");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator treats post-merge required evidence as a post-merge validation gate", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "post-merge-evidence" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            node: integrationNode({
                nodeId: "post-merge-evidence",
                slug: "post-merge-evidence",
                completionGates: ["controller-validation", "native-git-integration"],
                validation: { requiredEvidence: ["post-merge-validation-ran"] },
            }),
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "post-merge-evidence",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "complete");
        assert.match(result.summary, /post-merge validation passed/);
        assert.match(result.validationSignals?.join("\n") ?? "", /post-merge validator passed/);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator fails closed when required post-merge validation is disabled by host policy", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "post-merge-disabled" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const controllerHead = git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            postMergeValidation: false,
            node: integrationNode({
                nodeId: "post-merge-disabled",
                slug: "post-merge-disabled",
                completionGates: ["controller-validation", "native-git-integration", "post-merge-validation"],
            }),
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "post-merge-disabled",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "failed");
        assert.match(result.summary, /post-merge validation required but disabled by host policy/);
        assert.match(result.validationSignals?.join("\n") ?? "", /disabled by host policy/);
        assert.match(result.followupPrompt ?? "", /POST_MERGE_VALIDATION/);
        assert.equal(git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]), controllerHead);
        assert.equal(existsSync(join(controller.worktreePath, "feature.txt")), false);
        assert.equal(git(controller.worktreePath, ["status", "--porcelain=v1"]), "");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator skips post-merge validators without a post-merge gate", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "no-post-merge" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            node: integrationNode({
                nodeId: "no-post-merge",
                slug: "no-post-merge",
                validators: ["test -f missing-post-merge.txt"],
                completionGates: ["controller-validation", "native-git-integration"],
            }),
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "no-post-merge",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "complete");
        assert.doesNotMatch(result.summary, /post-merge validation/);
        assert.equal(result.validationSignals?.length ?? 0, 0);
        assert.equal(git(controller.worktreePath, ["show", "HEAD:feature.txt"]), "implemented");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator aborts merge when post-merge validation fails", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "post-merge-fail" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const controllerHead = git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            node: integrationNode({
                nodeId: "post-merge-fail",
                slug: "post-merge-fail",
                validators: ["test -f missing-post-merge.txt"],
                completionGates: ["controller-validation", "native-git-integration", "post-merge-validation"],
            }),
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "post-merge-fail",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "failed");
        assert.match(result.summary, /post-merge validation failed/);
        assert.match(result.followupPrompt ?? "", /POST_MERGE_VALIDATION/);
        assert.match(result.validationSignals?.join("\n") ?? "", /post-merge validator failed: test -f missing-post-merge\.txt/);
        assert.equal(git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]), controllerHead);
        assert.equal(existsSync(join(controller.worktreePath, "feature.txt")), false);
        assert.equal(git(controller.worktreePath, ["status", "--porcelain=v1"]), "");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator aborts and cleans when post-merge validators mutate the controller workspace", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "post-merge-mutates" });
        writeFileSync(join(allocation.worktreePath, "feature.txt"), "implemented\n");
        git(allocation.worktreePath, ["add", "feature.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "implement feature"]);
        const controllerHead = git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        mkdirSync(join(controller.worktreePath, ".worktrees", "preserved"), { recursive: true });
        writeFileSync(join(controller.worktreePath, ".worktrees", "preserved", "keep.txt"), "keep\n");
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            node: integrationNode({
                nodeId: "post-merge-mutates",
                slug: "post-merge-mutates",
                validators: ["printf 'validator mutation\\n' > feature.txt", "printf 'generated\\n' > generated.txt"],
                completionGates: ["controller-validation", "native-git-integration", "post-merge-validation"],
            }),
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "post-merge-mutates",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "failed");
        assert.match(result.summary, /mutated controller workspace/);
        assert.match(result.validationSignals?.join("\n") ?? "", /post-merge validator mutated controller workspace/);
        assert.equal(git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]), controllerHead);
        assert.equal(existsSync(join(controller.worktreePath, "feature.txt")), false);
        assert.equal(existsSync(join(controller.worktreePath, "generated.txt")), false);
        assert.equal(existsSync(join(controller.worktreePath, ".worktrees", "preserved", "keep.txt")), true);
        assert.equal(git(controller.worktreePath, ["status", "--porcelain=v1"]).trim(), "?? .worktrees/");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator rejects dirty subagent worktrees with follow-up prompt", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "dirty" });
        writeFileSync(join(allocation.worktreePath, "dirty.txt"), "not committed\n");
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "dirty",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "failed");
        assert.match(result.summary, /uncommitted changes/);
        assert.match(result.followupPrompt ?? "", /commit/i);
        assert.equal(existsSync(join(controller.worktreePath, "dirty.txt")), false);
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integrator aborts merge conflicts and reports follow-up", () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "conflict" });
        writeFileSync(join(allocation.worktreePath, "README.md"), "# fixture\nsubagent\n");
        git(allocation.worktreePath, ["add", "README.md"]);
        git(allocation.worktreePath, ["commit", "-m", "subagent readme"]);
        writeFileSync(join(controller.worktreePath, "README.md"), "# fixture\ncontroller\n");
        git(controller.worktreePath, ["add", "README.md"]);
        git(controller.worktreePath, ["commit", "-m", "controller readme"]);
        const controllerHead = git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: controller.worktreePath,
            subagent: {
                goalId: "goal-abcdef12",
                nodeId: "conflict",
                subagentId: allocation.subagentId,
                harnessAdapterId: "fake",
                workspacePath: allocation.worktreePath,
                branch: allocation.branch,
                status: "controllerValidating",
                prompts: [],
                createdAt: "2026-06-02T00:00:00.000Z",
                updatedAt: "2026-06-02T00:00:00.000Z",
            },
        });
        assert.equal(result.status, "failed");
        assert.match(result.summary, /merge failed/i);
        assert.match(result.followupPrompt ?? "", /resolve conflicts/i);
        assert.equal(git(controller.worktreePath, ["rev-parse", "--verify", "HEAD"]), controllerHead);
        assert.equal(git(controller.worktreePath, ["status", "--porcelain=v1"]), "");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git branch integrator plugs into controller completion gate", async () => {
    const repo = createRepo();
    try {
        const manager = new NativeGitWorkspaceManager({ defaultBaseRef: "main", fetch: false });
        const controller = manager.allocateControllerWorkspace({ invocationCwd: repo, goalId: "goal-abcdef12", objective: "Controller" });
        const allocation = manager.allocateSubagentWorkspace({ invocationCwd: repo, controllerWorkspacePath: controller.worktreePath, goalId: "goal-abcdef12", nodeId: "build" });
        writeFileSync(join(allocation.worktreePath, "integrated.txt"), "yes\n");
        git(allocation.worktreePath, ["add", "integrated.txt"]);
        git(allocation.worktreePath, ["commit", "-m", "integrated"]);
        const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date("2026-06-02T00:00:00.000Z") } });
        await runtime.planGoalDag("goal-abcdef12", [{ nodeId: "build", objective: "Build", workspaceStrategy: "native-git-worktree" }], { now: "2026-06-02T00:00:00.000Z" });
        await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-abcdef12", "build"), status: "running", updatedAt: "2026-06-02T00:00:00.000Z" });
        await runtime.saveGoalSubagent({
            goalId: "goal-abcdef12",
            nodeId: "build",
            subagentId: allocation.subagentId,
            harnessAdapterId: "fake",
            workspacePath: allocation.worktreePath,
            branch: allocation.branch,
            status: "selfReportedComplete",
            prompts: [],
            selfReportedResult: "done",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:01:00.000Z",
        });
        const adapter = {
            adapterId: "fake",
            startSession() { throw new Error("not expected"); },
            sendPrompt() { },
            getSessionState() { return { status: "selfReportedComplete", selfReportedResult: "done" }; },
            abortSession() { },
        };
        const tick = await runtime.runGoalControllerTick("goal-abcdef12", {
            adapter,
            validator: () => ({ status: "passed", summary: "validation passed" }),
            integrator: createNativeGitSubagentBranchIntegrator(manager, { controllerWorkspacePath: controller.worktreePath }),
        });
        assert.equal(tick.completed.length, 1);
        const stored = await runtime.getGoalSubagent("goal-abcdef12", allocation.subagentId);
        assert.equal(stored?.integrationState, "complete");
        assert.ok(stored?.integrationCommitSha);
        assert.equal(git(controller.worktreePath, ["show", "HEAD:integrated.txt"]), "yes");
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: allocation.worktreePath, branch: allocation.branch, force: true });
        manager.cleanupWorkspace({ repoRoot: repo, worktreePath: controller.worktreePath, branch: controller.branch, force: true });
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
test("native git integration gate blocks false completion when no integrator is configured", async () => {
    const { runtime } = await (async () => {
        const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date("2026-06-02T00:00:00.000Z") } });
        await runtime.planGoalDag("goal-abcdef12", [{ nodeId: "build", objective: "Build", workspaceStrategy: "native-git-worktree" }], { now: "2026-06-02T00:00:00.000Z" });
        return { runtime };
    })();
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-abcdef12", "build"), status: "running", updatedAt: "2026-06-02T00:00:00.000Z" });
    await runtime.saveGoalSubagent({
        goalId: "goal-abcdef12",
        nodeId: "build",
        subagentId: "subagent-1",
        harnessAdapterId: "fake",
        workspacePath: "/repo/.worktrees/build",
        branch: "goal/build",
        status: "selfReportedComplete",
        prompts: [],
        selfReportedResult: "done",
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: "2026-06-02T00:01:00.000Z",
    });
    const adapter = {
        adapterId: "fake",
        startSession() { throw new Error("not expected"); },
        sendPrompt() { },
        getSessionState() { return { status: "selfReportedComplete", selfReportedResult: "done" }; },
        abortSession() { },
    };
    const tick = await runtime.runGoalControllerTick("goal-abcdef12", {
        adapter,
        validator: () => ({ status: "passed", summary: "validation passed" }),
    });
    assert.equal(tick.completed.length, 0);
    assert.equal(tick.blocked.length, 1);
    assert.equal((await runtime.getGoalDagNode("goal-abcdef12", "build"))?.status, "blocked");
    assert.equal((await runtime.getGoalSubagent("goal-abcdef12", "subagent-1"))?.integrationState, "failed");
});
test("native git manager reports explicit setup errors outside git", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-no-git-"));
    try {
        const manager = new NativeGitWorkspaceManager({ fetch: false });
        assert.equal(findGitRepositoryRoot(dir), undefined);
        assert.throws(() => manager.allocateControllerWorkspace({ invocationCwd: dir, goalId: "goal-1", objective: "Do work" }), /not inside a Git repository/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("goal slugs are stable and safe for branch names", () => {
    assert.equal(slugForGoal("abcdef12-3456", "Build controller DAG + subagent registry!"), "abcdef12-build-controller-dag-subagent-registry");
    assert.equal(slugForGoalSubagent("abcdef12-3456", "Implement Attendance DocTypes"), "abcdef12-implement-attendance-doctypes");
    assert.match(slugForGoal("目標", "完成"), /^[a-f0-9-]+$/);
});
test("legacy goal/final-verification branch does not block new goal-scoped allocation", () => {
    const repo = createRepo();
    const manager = new NativeGitWorkspaceManager({ branchPrefix: "goal", fetch: false });
    // Simulate legacy branch from old goal.
    const legacyBranch = "goal/final-verification";
    git(repo, ["checkout", "-b", legacyBranch]);
    writeFileSync(join(repo, "legacy.md"), "# old goal\n");
    git(repo, ["add", "legacy.md"]);
    git(repo, ["commit", "-m", "legacy"]);
    git(repo, ["checkout", "main"]);
    // New goal's allocation must not be blocked.
    const allocation = manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "16c4f3b3-5ffb-4be9-a556-b7874b069cf1",
        nodeId: "final-verification",
        nodeSlug: "final-verification",
        subagentId: "subagent-final-verification",
    });
    assert.ok(allocation.worktreePath, "worktree must be allocated");
    assert.ok(allocation.branch, "branch must be set");
    // Branch must be goal-scoped, NOT the legacy one.
    assert.notEqual(allocation.branch, legacyBranch, "must not reuse legacy branch");
    assert.ok(allocation.branch?.startsWith("goal/16c4f3b3"), `branch must contain goal id prefix, got: ${allocation.branch}`);
    // Verify legacy branch still exists.
    const branches = git(repo, ["branch", "--list", legacyBranch]).trim();
    assert.ok(branches.length > 0, "legacy branch must be preserved");
});
test("same node id in different goals creates different branches", () => {
    const repo = createRepo();
    const manager = new NativeGitWorkspaceManager({ branchPrefix: "goal", fetch: false });
    const allocA = manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "aaaaaaaa-1111-1111-1111-111111111111",
        nodeId: "final-verification",
        nodeSlug: "final-verification",
        subagentId: "subagent-fv-a",
    });
    const allocB = manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "bbbbbbbb-2222-2222-2222-222222222222",
        nodeId: "final-verification",
        nodeSlug: "final-verification",
        subagentId: "subagent-fv-b",
    });
    assert.ok(allocA.branch, "goal A branch must be set");
    assert.ok(allocB.branch, "goal B branch must be set");
    assert.notEqual(allocA.branch, allocB.branch, "different goals must have different branches");
    assert.ok(allocA.branch?.startsWith("goal/aaaaaaaa-1"), `goal A branch: ${allocA.branch}`);
    assert.ok(allocB.branch?.startsWith("goal/bbbbbbbb-2"), `goal B branch: ${allocB.branch}`);
    assert.ok(allocA.worktreePath !== allocB.worktreePath, "different goals must have different worktree paths");
});
test("explicitly-bound subagent workspace reuses clean matching branch", () => {
    const repo = createRepo();
    const manager = new NativeGitWorkspaceManager({ branchPrefix: "goal", fetch: false });
    // First allocation creates the workspace.
    const first = manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "cccccccc-3333-3333-3333-333333333333",
        nodeId: "bound-node",
        nodeSlug: "bound-node",
        subagentId: "subagent-bound",
        worktreeSlug: "bound-node",
        branch: "goal/cccccccc-3/bound-node",
    });
    assert.ok(first.created, "first allocation must create");
    // Simulate clean reuse: same args again.
    const second = manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "cccccccc-3333-3333-3333-333333333333",
        nodeId: "bound-node",
        nodeSlug: "bound-node",
        subagentId: "subagent-bound",
        worktreeSlug: "bound-node",
        branch: "goal/cccccccc-3/bound-node",
    });
    assert.equal(second.created, false, "second allocation must reuse existing workspace");
    assert.equal(second.worktreePath, first.worktreePath, "must reuse same path");
    assert.equal(second.branch, first.branch, "must reuse same branch");
});
test("dirty explicitly-bound workspace is rejected", () => {
    const repo = createRepo();
    const manager = new NativeGitWorkspaceManager({ branchPrefix: "goal", fetch: false });
    const first = manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "dddddddd-4444-4444-4444-444444444444",
        nodeId: "dirty-node",
        nodeSlug: "dirty-node",
        subagentId: "subagent-dirty",
        worktreeSlug: "dirty-node",
        branch: "goal/dddddddd-4/dirty-node",
    });
    assert.ok(first.created);
    // Make the workspace dirty.
    writeFileSync(join(first.worktreePath ?? "", "uncommitted.txt"), "dirty");
    git(first.worktreePath ?? repo, ["add", "uncommitted.txt"]);
    assert.throws(() => manager.allocateSubagentWorkspace({
        invocationCwd: repo,
        goalId: "dddddddd-4444-4444-4444-444444444444",
        nodeId: "dirty-node",
        nodeSlug: "dirty-node",
        subagentId: "subagent-dirty",
        worktreeSlug: "dirty-node",
        branch: "goal/dddddddd-4/dirty-node",
    }), /uncommitted changes/, "dirty workspace must be rejected");
});
//# sourceMappingURL=native-git-workspace.test.js.map