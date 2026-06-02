import { createGoalDagNodes, type GoalDagPlanNodeInput, type GoalDagPlanOptions } from "./dag-scheduler.js";
import type { GoalDagConflictHints, GoalDagNode } from "./types.js";

export type GoalDagPlannerDependencyMode = "sequential" | "independent";

export interface GoalDagObjectivePlanOptions extends GoalDagPlanOptions {
  /** Default validators copied onto every planned node unless overridden by inline annotations. */
  defaultValidators?: string[];
  /** Default expected outputs copied onto every planned node unless overridden by inline annotations. */
  defaultExpectedOutputs?: string[];
  /** Default conflict hints copied onto every planned node unless overridden by inline annotations. */
  defaultConflictHints?: GoalDagConflictHints;
  /** Default dependency behavior for explicit task lists. Defaults to sequential. */
  dependencyMode?: GoalDagPlannerDependencyMode;
  /** Maximum number of nodes the deterministic planner may emit. Defaults to 20. */
  maxNodes?: number;
}

export interface GoalDagPlannerResult {
  goalId: string;
  nodeInputs: GoalDagPlanNodeInput[];
  rationale: string[];
  warnings: string[];
}

export interface GoalDagPlannedNodesResult extends GoalDagPlannerResult {
  nodes: GoalDagNode[];
}

interface ParsedTaskLine {
  text: string;
  ordinal: number;
  explicitId?: string;
  dependencyNodeIds?: string[];
  parallel?: boolean;
  validators?: string[];
  expectedOutputs?: string[];
  conflictHints?: GoalDagConflictHints;
}

const DEFAULT_MAX_NODES = 20;
const TASK_LINE_PATTERN = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+?)\s*$/;
const HEADING_PATTERN = /^\s{0,3}#{2,6}\s+(.+?)\s*$/;
const ANNOTATION_PATTERN = /\[\s*([a-zA-Z_-]+)\s*:\s*([^\]]+?)\s*\]/g;
const FLAG_PATTERN = /\[\s*(parallel|independent)\s*\]/gi;

export function planGoalDagFromObjective(
  goalId: string,
  objectiveInput: string,
  options: GoalDagObjectivePlanOptions = {},
): GoalDagPlannerResult {
  const objective = objectiveInput.trim();
  if (!objective) throw new Error("goal objective is required to plan a DAG");

  const taskLines = extractTaskLines(objective);
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (taskLines.length > maxNodes) {
    throw new Error(`goal DAG planner produced ${taskLines.length} nodes, exceeding maxNodes=${maxNodes}`);
  }

  if (taskLines.length === 0) {
    return {
      goalId,
      nodeInputs: [buildSingleNodeInput(objective, options)],
      rationale: ["No explicit task list was found; planned one controller-owned execution node for the objective."],
      warnings: [],
    };
  }

  const dependencyMode = options.dependencyMode ?? "sequential";
  const nodeInputs: GoalDagPlanNodeInput[] = [];
  const warnings: string[] = [];
  let previousNodeId: string | undefined;

  for (const task of taskLines) {
    const nodeId = sanitizeSlug(task.explicitId ?? task.text) || `node-${task.ordinal}`;
    const inferredDependencyIds = dependencyMode === "sequential" && previousNodeId && !task.parallel ? [previousNodeId] : [];
    const dependencyNodeIds = task.dependencyNodeIds ?? inferredDependencyIds;
    const input: GoalDagPlanNodeInput = {
      nodeId,
      slug: nodeId,
      objective: task.text,
      dependencyNodeIds,
      expectedOutputs: task.expectedOutputs ?? [...(options.defaultExpectedOutputs ?? [])],
      validators: task.validators ?? [...(options.defaultValidators ?? [])],
      workspaceStrategy: options.defaultWorkspaceStrategy,
      conflictHints: task.conflictHints ?? cloneConflictHints(options.defaultConflictHints),
      completionGates: options.defaultCompletionGates,
    };
    nodeInputs.push(input);
    previousNodeId = nodeId;
    if (task.parallel && dependencyMode === "sequential") warnings.push(`node ${nodeId} opted out of inferred sequential dependency via [parallel]`);
  }

  return {
    goalId,
    nodeInputs,
    rationale: [
      `Found ${taskLines.length} explicit task line${taskLines.length === 1 ? "" : "s"} in the objective.`,
      `Applied ${dependencyMode} dependency mode${dependencyMode === "sequential" ? " with [parallel] opt-outs" : ""}.`,
    ],
    warnings,
  };
}

export function createGoalDagNodesFromObjective(
  goalId: string,
  objective: string,
  options: GoalDagObjectivePlanOptions = {},
): GoalDagPlannedNodesResult {
  const plan = planGoalDagFromObjective(goalId, objective, options);
  return {
    ...plan,
    nodes: createGoalDagNodes(goalId, plan.nodeInputs, options),
  };
}

function buildSingleNodeInput(objective: string, options: GoalDagObjectivePlanOptions): GoalDagPlanNodeInput {
  const nodeId = sanitizeSlug(objective) || "execute-goal";
  return {
    nodeId,
    slug: nodeId,
    objective,
    dependencyNodeIds: [],
    expectedOutputs: [...(options.defaultExpectedOutputs ?? [])],
    validators: [...(options.defaultValidators ?? [])],
    workspaceStrategy: options.defaultWorkspaceStrategy,
    conflictHints: cloneConflictHints(options.defaultConflictHints),
    completionGates: options.defaultCompletionGates,
  };
}

function extractTaskLines(objective: string): ParsedTaskLine[] {
  const lines = objective.split("\n");
  const tasks: ParsedTaskLine[] = [];
  let ordinal = 0;
  for (const line of lines) {
    const taskMatch = line.match(TASK_LINE_PATTERN);
    const headingMatch = taskMatch ? undefined : line.match(HEADING_PATTERN);
    const rawText = taskMatch?.[1] ?? headingMatch?.[1];
    if (!rawText) continue;
    const parsed = parseTaskLine(rawText, ++ordinal);
    if (parsed.text) tasks.push(parsed);
  }
  return tasks;
}

function parseTaskLine(rawText: string, ordinal: number): ParsedTaskLine {
  const annotations = new Map<string, string[]>();
  let text = rawText.replace(ANNOTATION_PATTERN, (_match, rawKey: string, rawValue: string) => {
    const key = normalizeAnnotationKey(rawKey);
    const values = splitAnnotationValues(rawValue);
    annotations.set(key, [...(annotations.get(key) ?? []), ...values]);
    return "";
  });
  let parallel = false;
  text = text.replace(FLAG_PATTERN, () => {
    parallel = true;
    return "";
  });
  text = text.replace(/\s+/g, " ").trim();

  const dependencyNodeIds = annotationValues(annotations, "deps").map(sanitizeSlug).filter(Boolean);
  const validators = annotationValues(annotations, "validators");
  const expectedOutputs = annotationValues(annotations, "outputs");
  return {
    text,
    ordinal,
    explicitId: firstValue(annotations, "id"),
    dependencyNodeIds: dependencyNodeIds.length ? dependencyNodeIds : undefined,
    parallel,
    validators: validators.length ? validators : undefined,
    expectedOutputs: expectedOutputs.length ? expectedOutputs : undefined,
    conflictHints: conflictHintsFromAnnotations(annotations),
  };
}

function normalizeAnnotationKey(key: string): string {
  const normalized = key.toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "after":
    case "dep":
    case "depends":
    case "dependencies":
      return "deps";
    case "validator":
    case "checks":
    case "check":
      return "validators";
    case "output":
    case "expected-output":
    case "expected-outputs":
      return "outputs";
    case "file":
      return "files";
    case "module":
      return "modules";
    case "capability":
      return "capabilities";
    default:
      return normalized;
  }
}

function splitAnnotationValues(value: string): string[] {
  return value
    .split(/[|,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function annotationValues(annotations: Map<string, string[]>, key: string): string[] {
  return [...(annotations.get(key) ?? [])];
}

function firstValue(annotations: Map<string, string[]>, key: string): string | undefined {
  const value = annotations.get(key)?.[0];
  return value?.trim() || undefined;
}

function conflictHintsFromAnnotations(annotations: Map<string, string[]>): GoalDagConflictHints | undefined {
  const hints: GoalDagConflictHints = {};
  const files = annotationValues(annotations, "files");
  const modules = annotationValues(annotations, "modules");
  const capabilities = annotationValues(annotations, "capabilities");
  if (files.length) hints.files = files;
  if (modules.length) hints.modules = modules;
  if (capabilities.length) hints.capabilities = capabilities;
  return hints.files?.length || hints.modules?.length || hints.capabilities?.length ? hints : undefined;
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
