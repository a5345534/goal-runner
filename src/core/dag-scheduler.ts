import type { GoalDagConflictHints, GoalDagNode, GoalDagNodeStatus, GoalOrchestrationState, GoalSubagentRecord } from "./types.js";

export interface GoalDagPlanNodeInput {
  nodeId?: string;
  slug?: string;
  objective: string;
  scope?: string;
  dependencyNodeIds?: string[];
  expectedOutputs?: string[];
  validators?: string[];
  workspaceStrategy?: string;
  risk?: GoalDagNode["risk"];
  modelScenario?: string;
  modelArg?: string;
  conflictHints?: GoalDagConflictHints;
  completionGates?: string[];
  status?: GoalDagNodeStatus;
}

export interface GoalDagPlanOptions {
  now?: Date | string;
  defaultWorkspaceStrategy?: string;
  defaultCompletionGates?: string[];
}

export interface GoalDagValidationResult {
  ok: boolean;
  errors: string[];
}

export interface GoalDagSchedulingPolicy {
  /** Maximum nodes to return as schedulable. Defaults to unlimited after accounting for active subagents. */
  maxConcurrentSubagents?: number;
  /** Treat matching conflict-hint file entries as mutually exclusive. Defaults true. */
  serializeOnFiles?: boolean;
  /** Treat matching conflict-hint module entries as mutually exclusive. Defaults true. */
  serializeOnModules?: boolean;
  /** Treat matching conflict-hint capability entries as mutually exclusive. Defaults true. */
  serializeOnCapabilities?: boolean;
}

export interface GoalDagReadyQueue {
  ready: GoalDagNode[];
  blocked: Array<{ node: GoalDagNode; reasons: string[] }>;
  running: GoalDagNode[];
  capacity: number;
}

const RUNNING_NODE_STATUSES = new Set<GoalDagNodeStatus>(["running", "selfReportedComplete", "controllerValidating"]);
const TERMINAL_SUCCESS_STATUSES = new Set<GoalDagNodeStatus>(["complete"]);
const TERMINAL_BLOCKED_STATUSES = new Set<GoalDagNodeStatus>(["blocked", "failed", "superseded"]);
const SCHEDULABLE_NODE_STATUSES = new Set<GoalDagNodeStatus>(["planned", "ready", "needsFollowup"]);

export function createGoalDagNodes(goalId: string, inputs: GoalDagPlanNodeInput[], options: GoalDagPlanOptions = {}): GoalDagNode[] {
  const timestamp = toIso(options.now ?? new Date());
  const nodes = inputs.map((input, index): GoalDagNode => {
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

export function validateGoalDag(nodes: GoalDagNode[]): GoalDagValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const node of nodes) {
    if (!node.goalId) errors.push(`node ${node.nodeId || "<missing>"} is missing goalId`);
    if (!node.nodeId) errors.push("node is missing nodeId");
    if (!node.slug) errors.push(`node ${node.nodeId || "<missing>"} is missing slug`);
    if (!node.objective.trim()) errors.push(`node ${node.nodeId || "<missing>"} is missing objective`);
    if (ids.has(node.nodeId)) errors.push(`duplicate node id: ${node.nodeId}`);
    ids.add(node.nodeId);
  }

  for (const node of nodes) {
    for (const dependencyId of node.dependencyNodeIds) {
      if (!ids.has(dependencyId)) errors.push(`node ${node.nodeId} depends on missing node ${dependencyId}`);
      if (dependencyId === node.nodeId) errors.push(`node ${node.nodeId} depends on itself`);
    }
  }

  const cycle = findCycle(nodes);
  if (cycle.length > 0) errors.push(`cycle detected: ${cycle.join(" -> ")}`);

  return { ok: errors.length === 0, errors };
}

export function assertValidGoalDag(nodes: GoalDagNode[]): void {
  const result = validateGoalDag(nodes);
  if (!result.ok) throw new Error(`Invalid goal DAG: ${result.errors.join("; ")}`);
}

export function getGoalDagReadyQueue(state: GoalOrchestrationState, policy: GoalDagSchedulingPolicy = {}): GoalDagReadyQueue {
  assertValidGoalDag(state.nodes);
  const nodeById = new Map(state.nodes.map((node) => [node.nodeId, node]));
  const runningNodeIds = new Set(state.subagents.filter(isActiveSubagent).map((subagent) => subagent.nodeId));
  for (const node of state.nodes) {
    if (RUNNING_NODE_STATUSES.has(node.status)) runningNodeIds.add(node.nodeId);
  }

  const maxConcurrent = policy.maxConcurrentSubagents ?? Number.POSITIVE_INFINITY;
  const activeCount = runningNodeIds.size;
  const capacity = Number.isFinite(maxConcurrent) ? Math.max(0, maxConcurrent - activeCount) : Number.POSITIVE_INFINITY;
  const ready: GoalDagNode[] = [];
  const blocked: Array<{ node: GoalDagNode; reasons: string[] }> = [];
  const running: GoalDagNode[] = [...runningNodeIds].map((nodeId) => nodeById.get(nodeId)).filter((node): node is GoalDagNode => Boolean(node));

  const blockers = running.map((node) => node);
  const ordered = topologicalSort(state.nodes);
  for (const node of ordered) {
    if (runningNodeIds.has(node.nodeId)) continue;
    if (TERMINAL_SUCCESS_STATUSES.has(node.status) || TERMINAL_BLOCKED_STATUSES.has(node.status)) continue;
    if (!SCHEDULABLE_NODE_STATUSES.has(node.status)) {
      blocked.push({ node, reasons: [`status ${node.status} is not schedulable`] });
      continue;
    }

    const reasons = dependencyBlockers(node, nodeById);
    const conflict = firstConflict(node, blockers, policy);
    if (conflict) reasons.push(conflict);

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

function dependencyBlockers(node: GoalDagNode, nodeById: Map<string, GoalDagNode>): string[] {
  const reasons: string[] = [];
  for (const dependencyId of node.dependencyNodeIds) {
    const dependency = nodeById.get(dependencyId);
    if (!dependency) {
      reasons.push(`dependency ${dependencyId} is missing`);
    } else if (dependency.status !== "complete") {
      reasons.push(`dependency ${dependencyId} is ${dependency.status}`);
    }
  }
  return reasons;
}

function firstConflict(node: GoalDagNode, blockers: GoalDagNode[], policy: GoalDagSchedulingPolicy): string | undefined {
  for (const blocker of blockers) {
    if (shouldSerialize(node, blocker, policy, "files")) return `conflicts with ${blocker.nodeId} on files`;
    if (shouldSerialize(node, blocker, policy, "modules")) return `conflicts with ${blocker.nodeId} on modules`;
    if (shouldSerialize(node, blocker, policy, "capabilities")) return `conflicts with ${blocker.nodeId} on capabilities`;
  }
  return undefined;
}

function shouldSerialize(
  node: GoalDagNode,
  blocker: GoalDagNode,
  policy: GoalDagSchedulingPolicy,
  field: keyof GoalDagConflictHints,
): boolean {
  const enabled = field === "files"
    ? policy.serializeOnFiles !== false
    : field === "modules"
      ? policy.serializeOnModules !== false
      : policy.serializeOnCapabilities !== false;
  if (!enabled) return false;
  return intersects(node.conflictHints?.[field], blocker.conflictHints?.[field]);
}

function intersects(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left?.length || !right?.length) return false;
  const normalized = new Set(left.map((item) => item.toLowerCase()));
  return right.some((item) => normalized.has(item.toLowerCase()));
}

function isActiveSubagent(subagent: GoalSubagentRecord): boolean {
  return ["workspaceCreated", "sessionStarted", "running", "idle", "selfReportedComplete", "controllerValidating"].includes(subagent.status);
}

function topologicalSort(nodes: GoalDagNode[]): GoalDagNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: GoalDagNode[] = [];

  const visit = (node: GoalDagNode) => {
    if (visited.has(node.nodeId)) return;
    if (visiting.has(node.nodeId)) return;
    visiting.add(node.nodeId);
    for (const dependencyId of node.dependencyNodeIds) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    }
    visiting.delete(node.nodeId);
    visited.add(node.nodeId);
    result.push(node);
  };

  for (const node of nodes) visit(node);
  return result;
}

function findCycle(nodes: GoalDagNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: GoalDagNode): string[] | undefined => {
    if (visiting.has(node.nodeId)) {
      const start = stack.indexOf(node.nodeId);
      return [...stack.slice(start), node.nodeId];
    }
    if (visited.has(node.nodeId)) return undefined;
    visiting.add(node.nodeId);
    stack.push(node.nodeId);
    for (const dependencyId of node.dependencyNodeIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node.nodeId);
    visited.add(node.nodeId);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return [];
}

function cloneConflictHints(hints: GoalDagConflictHints | undefined): GoalDagConflictHints | undefined {
  if (!hints) return undefined;
  return {
    files: hints.files ? [...hints.files] : undefined,
    modules: hints.modules ? [...hints.modules] : undefined,
    capabilities: hints.capabilities ? [...hints.capabilities] : undefined,
  };
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
