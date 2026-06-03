const RUNNING_NODE_STATUSES = new Set(["running", "selfReportedComplete", "controllerValidating"]);
const TERMINAL_SUCCESS_STATUSES = new Set(["complete"]);
const TERMINAL_BLOCKED_STATUSES = new Set(["blocked", "failed", "superseded"]);
const SCHEDULABLE_NODE_STATUSES = new Set(["planned", "ready", "needsFollowup"]);
export function createGoalDagNodes(goalId, inputs, options = {}) {
    const timestamp = toIso(options.now ?? new Date());
    const nodes = inputs.map((input, index) => {
        const slug = input.slug ? sanitizeSlug(input.slug) : sanitizeSlug(input.objective) || `node-${index + 1}`;
        const nodeId = input.nodeId ? sanitizeSlug(input.nodeId) : slug;
        return {
            goalId,
            nodeId,
            slug,
            objective: input.objective,
            scope: input.scope,
            dependencyNodeIds: [...(input.dependencyNodeIds ?? [])],
            expectedOutputs: [...(input.expectedOutputs ?? [])],
            validators: [...(input.validators ?? [])],
            workspaceStrategy: input.workspaceStrategy ?? options.defaultWorkspaceStrategy,
            risk: input.risk,
            modelScenario: input.modelScenario,
            modelArg: input.modelArg,
            conflictHints: cloneConflictHints(input.conflictHints),
            completionGates: [...(input.completionGates ?? options.defaultCompletionGates ?? ["controller-validation"])],
            status: input.status ?? "planned",
            createdAt: timestamp,
            updatedAt: timestamp,
        };
    });
    assertValidGoalDag(nodes);
    return nodes;
}
export function validateGoalDag(nodes) {
    const errors = [];
    const ids = new Set();
    for (const node of nodes) {
        if (!node.goalId)
            errors.push(`node ${node.nodeId || "<missing>"} is missing goalId`);
        if (!node.nodeId)
            errors.push("node is missing nodeId");
        if (!node.slug)
            errors.push(`node ${node.nodeId || "<missing>"} is missing slug`);
        if (!node.objective.trim())
            errors.push(`node ${node.nodeId || "<missing>"} is missing objective`);
        if (ids.has(node.nodeId))
            errors.push(`duplicate node id: ${node.nodeId}`);
        ids.add(node.nodeId);
    }
    for (const node of nodes) {
        for (const dependencyId of node.dependencyNodeIds) {
            if (!ids.has(dependencyId))
                errors.push(`node ${node.nodeId} depends on missing node ${dependencyId}`);
            if (dependencyId === node.nodeId)
                errors.push(`node ${node.nodeId} depends on itself`);
        }
    }
    const cycle = findCycle(nodes);
    if (cycle.length > 0)
        errors.push(`cycle detected: ${cycle.join(" -> ")}`);
    return { ok: errors.length === 0, errors };
}
export function assertValidGoalDag(nodes) {
    const result = validateGoalDag(nodes);
    if (!result.ok)
        throw new Error(`Invalid goal DAG: ${result.errors.join("; ")}`);
}
export function getGoalDagReadyQueue(state, policy = {}) {
    assertValidGoalDag(state.nodes);
    const nodeById = new Map(state.nodes.map((node) => [node.nodeId, node]));
    const runningNodeIds = new Set(state.subagents.filter(isActiveSubagent).map((subagent) => subagent.nodeId));
    for (const node of state.nodes) {
        if (RUNNING_NODE_STATUSES.has(node.status))
            runningNodeIds.add(node.nodeId);
    }
    const maxConcurrent = policy.maxConcurrentSubagents ?? Number.POSITIVE_INFINITY;
    const activeCount = runningNodeIds.size;
    const capacity = Number.isFinite(maxConcurrent) ? Math.max(0, maxConcurrent - activeCount) : Number.POSITIVE_INFINITY;
    const ready = [];
    const blocked = [];
    const running = [...runningNodeIds].map((nodeId) => nodeById.get(nodeId)).filter((node) => Boolean(node));
    const blockers = running.map((node) => node);
    const ordered = topologicalSort(state.nodes);
    for (const node of ordered) {
        if (runningNodeIds.has(node.nodeId))
            continue;
        if (TERMINAL_SUCCESS_STATUSES.has(node.status) || TERMINAL_BLOCKED_STATUSES.has(node.status))
            continue;
        if (!SCHEDULABLE_NODE_STATUSES.has(node.status)) {
            blocked.push({ node, reasons: [`status ${node.status} is not schedulable`] });
            continue;
        }
        const reasons = dependencyBlockers(node, nodeById);
        const conflict = firstConflict(node, blockers, policy);
        if (conflict)
            reasons.push(conflict);
        if (reasons.length > 0) {
            blocked.push({ node, reasons });
            continue;
        }
        if (ready.length >= capacity) {
            blocked.push({ node, reasons: ["concurrency capacity exhausted"] });
            continue;
        }
        ready.push(node);
        blockers.push(node);
    }
    return { ready, blocked, running, capacity: Number.isFinite(capacity) ? capacity : ready.length };
}
function dependencyBlockers(node, nodeById) {
    const reasons = [];
    for (const dependencyId of node.dependencyNodeIds) {
        const dependency = nodeById.get(dependencyId);
        if (!dependency) {
            reasons.push(`dependency ${dependencyId} is missing`);
        }
        else if (dependency.status !== "complete") {
            reasons.push(`dependency ${dependencyId} is ${dependency.status}`);
        }
    }
    return reasons;
}
function firstConflict(node, blockers, policy) {
    for (const blocker of blockers) {
        if (shouldSerialize(node, blocker, policy, "files"))
            return `conflicts with ${blocker.nodeId} on files`;
        if (shouldSerialize(node, blocker, policy, "modules"))
            return `conflicts with ${blocker.nodeId} on modules`;
        if (shouldSerialize(node, blocker, policy, "capabilities"))
            return `conflicts with ${blocker.nodeId} on capabilities`;
    }
    return undefined;
}
function shouldSerialize(node, blocker, policy, field) {
    const enabled = field === "files"
        ? policy.serializeOnFiles !== false
        : field === "modules"
            ? policy.serializeOnModules !== false
            : policy.serializeOnCapabilities !== false;
    if (!enabled)
        return false;
    return intersects(node.conflictHints?.[field], blocker.conflictHints?.[field]);
}
function intersects(left, right) {
    if (!left?.length || !right?.length)
        return false;
    const normalized = new Set(left.map((item) => item.toLowerCase()));
    return right.some((item) => normalized.has(item.toLowerCase()));
}
function isActiveSubagent(subagent) {
    return ["workspaceCreated", "sessionStarted", "running", "idle", "selfReportedComplete", "controllerValidating"].includes(subagent.status);
}
function topologicalSort(nodes) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const visited = new Set();
    const visiting = new Set();
    const result = [];
    const visit = (node) => {
        if (visited.has(node.nodeId))
            return;
        if (visiting.has(node.nodeId))
            return;
        visiting.add(node.nodeId);
        for (const dependencyId of node.dependencyNodeIds) {
            const dependency = byId.get(dependencyId);
            if (dependency)
                visit(dependency);
        }
        visiting.delete(node.nodeId);
        visited.add(node.nodeId);
        result.push(node);
    };
    for (const node of nodes)
        visit(node);
    return result;
}
function findCycle(nodes) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const visiting = new Set();
    const visited = new Set();
    const stack = [];
    const visit = (node) => {
        if (visiting.has(node.nodeId)) {
            const start = stack.indexOf(node.nodeId);
            return [...stack.slice(start), node.nodeId];
        }
        if (visited.has(node.nodeId))
            return undefined;
        visiting.add(node.nodeId);
        stack.push(node.nodeId);
        for (const dependencyId of node.dependencyNodeIds) {
            const dependency = byId.get(dependencyId);
            if (!dependency)
                continue;
            const cycle = visit(dependency);
            if (cycle)
                return cycle;
        }
        stack.pop();
        visiting.delete(node.nodeId);
        visited.add(node.nodeId);
        return undefined;
    };
    for (const node of nodes) {
        const cycle = visit(node);
        if (cycle)
            return cycle;
    }
    return [];
}
function cloneConflictHints(hints) {
    if (!hints)
        return undefined;
    return {
        files: hints.files ? [...hints.files] : undefined,
        modules: hints.modules ? [...hints.modules] : undefined,
        capabilities: hints.capabilities ? [...hints.capabilities] : undefined,
    };
}
function sanitizeSlug(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}
function toIso(value) {
    return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
//# sourceMappingURL=dag-scheduler.js.map