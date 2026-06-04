import { createGoalDagNodes, type GoalDagPlanNodeInput, type GoalDagPlanOptions } from "./dag-scheduler.js";
import { assertKnownModelScenario, parseGoalModelRoutingConfig, selectModelScenarioForNode, type GoalModelRoutingConfig } from "./model-routing.js";
import type { GoalDagConflictHints, GoalDagNode } from "./types.js";
import type { GoalDagPlannedNodesResult, GoalDagPlannerResult } from "./dag-planner.js";

export interface GoalDagFileDocument {
  version: 1;
  objective: string;
  defaults?: GoalDagFileDefaults;
  modelRouting?: GoalModelRoutingConfig;
  nodes: GoalDagFileNode[];
}

export interface GoalDagFileDefaults {
  outputs?: string[];
  validators?: string[];
  workspaceStrategy?: string;
  completionGates?: string[];
  conflicts?: GoalDagConflictHints;
  modelScenario?: string;
}

export interface GoalDagFileNode {
  id: string;
  objective: string;
  after?: string[];
  outputs?: string[];
  validators?: string[];
  conflicts?: GoalDagConflictHints;
  scope?: string;
  workspaceStrategy?: string;
  risk?: GoalDagNode["risk"];
  completionGates?: string[];
  modelScenario?: string;
}

export interface GoalDagFilePlanOptions extends GoalDagPlanOptions {
  maxNodes?: number;
}

const DAG_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DEFAULT_MAX_NODES = 20;

export function parseGoalDagFileContent(content: string): GoalDagFileDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid goal DAG file JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseGoalDagFileDocument(parsed);
}

export function parseGoalDagFileDocument(input: unknown): GoalDagFileDocument {
  if (!isRecord(input)) throw new Error("Invalid goal DAG file: root must be an object");
  const version = input.version;
  if (version !== 1) throw new Error("Invalid goal DAG file: version must be 1");
  const objective = requireNonEmptyString(input.objective, "objective");
  const defaults = input.defaults === undefined ? undefined : parseDefaults(input.defaults, "defaults");
  const modelRouting = input.modelRouting === undefined ? undefined : parseGoalModelRoutingConfig(input.modelRouting, "modelRouting");
  if (!Array.isArray(input.nodes)) throw new Error("Invalid goal DAG file: nodes must be an array");
  if (input.nodes.length === 0) throw new Error("Invalid goal DAG file: nodes must not be empty");
  const nodes = input.nodes.map((node, index) => parseNode(node, `nodes[${index}]`));
  validateFileNodeGraph(nodes);
  validateFileModelScenarios(defaults, nodes, modelRouting);
  return {
    version,
    objective,
    ...(defaults ? { defaults } : {}),
    ...(modelRouting ? { modelRouting } : {}),
    nodes,
  };
}

export function planGoalDagFromFileDocument(
  goalId: string,
  document: GoalDagFileDocument,
  options: GoalDagFilePlanOptions = {},
): GoalDagPlannerResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (document.nodes.length > maxNodes) throw new Error(`goal DAG file contains ${document.nodes.length} nodes, exceeding maxNodes=${maxNodes}`);
  const defaultOutputs = document.defaults?.outputs ?? [];
  const defaultValidators = document.defaults?.validators ?? [];
  const defaultWorkspaceStrategy = document.defaults?.workspaceStrategy ?? options.defaultWorkspaceStrategy;
  const defaultCompletionGates = document.defaults?.completionGates ?? options.defaultCompletionGates;
  const defaultConflicts = document.defaults?.conflicts;
  const defaultModelScenario = document.defaults?.modelScenario;

  return {
    goalId,
    nodeInputs: document.nodes.map((node): GoalDagPlanNodeInput => {
      const expectedOutputs = [...(node.outputs ?? defaultOutputs)];
      const validators = [...(node.validators ?? defaultValidators)];
      const conflictHints = cloneConflictHints(node.conflicts ?? defaultConflicts);
      const selection = selectModelScenarioForNode({
        nodeId: node.id,
        objective: node.objective,
        scope: node.scope,
        risk: node.risk,
        expectedOutputs,
        validators,
        conflictHints,
        modelScenario: node.modelScenario ?? defaultModelScenario,
      }, document.modelRouting);
      const modelScenario = node.modelScenario ?? defaultModelScenario ?? selection.scenario;
      return {
        nodeId: node.id,
        slug: node.id,
        objective: node.objective,
        scope: node.scope,
        dependencyNodeIds: [...(node.after ?? [])],
        expectedOutputs,
        validators,
        workspaceStrategy: node.workspaceStrategy ?? defaultWorkspaceStrategy,
        risk: node.risk,
        modelScenario,
        modelArg: selection.model,
        conflictHints,
        completionGates: [...(node.completionGates ?? defaultCompletionGates ?? ["controller-validation"])],
      };
    }),
    rationale: [`Loaded ${document.nodes.length} DAG node${document.nodes.length === 1 ? "" : "s"} from goal DAG file.`],
    warnings: [],
  };
}

export function createGoalDagNodesFromFileDocument(
  goalId: string,
  document: GoalDagFileDocument,
  options: GoalDagFilePlanOptions = {},
): GoalDagPlannedNodesResult {
  const plan = planGoalDagFromFileDocument(goalId, document, options);
  return {
    ...plan,
    nodes: createGoalDagNodes(goalId, plan.nodeInputs, options),
  };
}

export function createGoalDagNodesFromFileContent(
  goalId: string,
  content: string,
  options: GoalDagFilePlanOptions = {},
): GoalDagPlannedNodesResult {
  return createGoalDagNodesFromFileDocument(goalId, parseGoalDagFileContent(content), options);
}

function parseDefaults(input: unknown, path: string): GoalDagFileDefaults {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  const defaults: GoalDagFileDefaults = {};
  if (input.outputs !== undefined) defaults.outputs = parseStringArray(input.outputs, `${path}.outputs`);
  if (input.validators !== undefined) defaults.validators = parseStringArray(input.validators, `${path}.validators`);
  if (input.workspaceStrategy !== undefined) defaults.workspaceStrategy = requireNonEmptyString(input.workspaceStrategy, `${path}.workspaceStrategy`);
  if (input.completionGates !== undefined) defaults.completionGates = parseStringArray(input.completionGates, `${path}.completionGates`);
  if (input.conflicts !== undefined) defaults.conflicts = parseConflicts(input.conflicts, `${path}.conflicts`);
  if (input.modelScenario !== undefined) defaults.modelScenario = requireNonEmptyString(input.modelScenario, `${path}.modelScenario`);
  return defaults;
}

function parseNode(input: unknown, path: string): GoalDagFileNode {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  const id = requireKebabId(input.id, `${path}.id`);
  const objective = requireNonEmptyString(input.objective, `${path}.objective`);
  const node: GoalDagFileNode = { id, objective };
  if (input.after !== undefined) node.after = parseIdArray(input.after, `${path}.after`);
  if (input.outputs !== undefined) node.outputs = parseStringArray(input.outputs, `${path}.outputs`);
  if (input.validators !== undefined) node.validators = parseStringArray(input.validators, `${path}.validators`);
  if (input.conflicts !== undefined) node.conflicts = parseConflicts(input.conflicts, `${path}.conflicts`);
  if (input.scope !== undefined) node.scope = requireNonEmptyString(input.scope, `${path}.scope`);
  if (input.workspaceStrategy !== undefined) node.workspaceStrategy = requireNonEmptyString(input.workspaceStrategy, `${path}.workspaceStrategy`);
  if (input.risk !== undefined) node.risk = parseRisk(input.risk, `${path}.risk`);
  if (input.completionGates !== undefined) node.completionGates = parseStringArray(input.completionGates, `${path}.completionGates`);
  if (input.modelScenario !== undefined) node.modelScenario = requireNonEmptyString(input.modelScenario, `${path}.modelScenario`);
  return node;
}

function validateFileNodeGraph(nodes: GoalDagFileNode[]): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Invalid goal DAG file: duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const dependency of node.after ?? []) {
      if (!ids.has(dependency)) throw new Error(`Invalid goal DAG file: node ${node.id} depends on missing node ${dependency}`);
      if (dependency === node.id) throw new Error(`Invalid goal DAG file: node ${node.id} depends on itself`);
    }
  }
  validateFileNodeAcyclicity(nodes);
}

function validateFileNodeAcyclicity(nodes: GoalDagFileNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: GoalDagFileNode): string[] | undefined => {
    if (visiting.has(node.id)) {
      const start = stack.indexOf(node.id);
      return [...stack.slice(start), node.id];
    }
    if (visited.has(node.id)) return undefined;
    visiting.add(node.id);
    stack.push(node.id);
    for (const dependencyId of node.after ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue; // missing-dep error handled separately
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node.id);
    visited.add(node.id);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle && cycle.length > 0) {
      throw new Error(`Invalid goal DAG file: cycle detected: ${cycle.join(" -> ")}`);
    }
  }
}

function validateFileModelScenarios(
  defaults: GoalDagFileDefaults | undefined,
  nodes: GoalDagFileNode[],
  modelRouting: GoalModelRoutingConfig | undefined,
): void {
  if (defaults?.modelScenario) assertKnownModelScenario(modelRouting, defaults.modelScenario, "defaults.modelScenario");
  nodes.forEach((node, index) => {
    if (node.modelScenario) assertKnownModelScenario(modelRouting, node.modelScenario, `nodes[${index}].modelScenario`);
  });
}

function parseConflicts(input: unknown, path: string): GoalDagConflictHints {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  const conflicts: GoalDagConflictHints = {};
  if (input.files !== undefined) conflicts.files = parseStringArray(input.files, `${path}.files`);
  if (input.modules !== undefined) conflicts.modules = parseStringArray(input.modules, `${path}.modules`);
  if (input.capabilities !== undefined) conflicts.capabilities = parseStringArray(input.capabilities, `${path}.capabilities`);
  return conflicts;
}

function parseRisk(input: unknown, path: string): GoalDagNode["risk"] {
  if (input === "low" || input === "medium" || input === "high") return input;
  throw new Error(`Invalid goal DAG file: ${path} must be one of low, medium, high`);
}

function parseIdArray(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) throw new Error(`Invalid goal DAG file: ${path} must be an array`);
  return input.map((item, index) => requireKebabId(item, `${path}[${index}]`));
}

function parseStringArray(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) throw new Error(`Invalid goal DAG file: ${path} must be an array`);
  return input.map((item, index) => requireNonEmptyString(item, `${path}[${index}]`));
}

function requireKebabId(input: unknown, path: string): string {
  const value = requireNonEmptyString(input, path);
  if (!DAG_ID_PATTERN.test(value)) throw new Error(`Invalid goal DAG file: ${path} must be kebab-case (${DAG_ID_PATTERN.source})`);
  return value;
}

function requireNonEmptyString(input: unknown, path: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`Invalid goal DAG file: ${path} must be a non-empty string`);
  return input.trim();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function cloneConflictHints(hints: GoalDagConflictHints | undefined): GoalDagConflictHints | undefined {
  if (!hints) return undefined;
  return {
    files: hints.files ? [...hints.files] : undefined,
    modules: hints.modules ? [...hints.modules] : undefined,
    capabilities: hints.capabilities ? [...hints.capabilities] : undefined,
  };
}
