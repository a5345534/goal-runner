import { createGoalDagNodes, type GoalDagPlanNodeInput, type GoalDagPlanOptions } from "./dag-scheduler.js";
import { assertKnownModelScenario, parseGoalModelRoutingConfig, selectModelScenarioForNode, type GoalModelRoutingConfig } from "./model-routing.js";
import type { GoalDagConflictHints, GoalDagNode, GoalDagValidationContract, GoalValidationArtifactLock } from "./types.js";
import type { GoalValidationEvidenceRequirement } from "./validation-evidence.js";
import { isSupportedRequiredEvidence, SUPPORTED_REQUIRED_EVIDENCE } from "./validation-evidence.js";
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
  thinkingLevel?: string;
}

export interface GoalDagFileNode {
  id: string;
  objective: string;
  after?: string[];
  outputs?: string[];
  validators?: string[];
  conflicts?: GoalDagConflictHints;
  scope?: string;
  kind?: GoalDagNode["kind"];
  validation?: GoalDagValidationContract;
  workspaceStrategy?: string;
  workspace?: GoalDagNode["workspace"];
  risk?: GoalDagNode["risk"];
  completionGates?: string[];
  modelScenario?: string;
  thinkingLevel?: string;
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
  assertKnownKeys(input, ["version", "objective", "defaults", "modelRouting", "nodes"], "root");
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
  const defaultThinkingLevel = document.defaults?.thinkingLevel;

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
        kind: node.kind,
        validation: cloneValidationContract(node.validation),
        dependencyNodeIds: [...(node.after ?? [])],
        expectedOutputs,
        validators,
        workspaceStrategy: node.workspaceStrategy ?? defaultWorkspaceStrategy,
        workspace: cloneWorkspaceBinding(node.workspace),
        risk: node.risk,
        modelScenario,
        modelArg: selection.model,
        thinkingLevel: node.thinkingLevel ?? defaultThinkingLevel,
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
  assertKnownKeys(input, ["outputs", "validators", "workspaceStrategy", "completionGates", "conflicts", "modelScenario", "thinkingLevel"], path);
  const defaults: GoalDagFileDefaults = {};
  if (input.outputs !== undefined) defaults.outputs = parseStringArray(input.outputs, `${path}.outputs`);
  if (input.validators !== undefined) defaults.validators = parseStringArray(input.validators, `${path}.validators`);
  if (input.workspaceStrategy !== undefined) defaults.workspaceStrategy = requireNonEmptyString(input.workspaceStrategy, `${path}.workspaceStrategy`);
  if (input.completionGates !== undefined) defaults.completionGates = parseStringArray(input.completionGates, `${path}.completionGates`);
  if (input.conflicts !== undefined) defaults.conflicts = parseConflicts(input.conflicts, `${path}.conflicts`);
  if (input.modelScenario !== undefined) defaults.modelScenario = requireNonEmptyString(input.modelScenario, `${path}.modelScenario`);
  if (input.thinkingLevel !== undefined) defaults.thinkingLevel = requireNonEmptyString(input.thinkingLevel, `${path}.thinkingLevel`);
  return defaults;
}

function parseNode(input: unknown, path: string): GoalDagFileNode {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  assertKnownKeys(input, ["id", "objective", "after", "outputs", "validators", "conflicts", "scope", "kind", "validation", "workspaceStrategy", "workspace", "risk", "completionGates", "modelScenario", "thinkingLevel"], path);
  const id = requireKebabId(input.id, `${path}.id`);
  const objective = requireNonEmptyString(input.objective, `${path}.objective`);
  const node: GoalDagFileNode = { id, objective };
  if (input.after !== undefined) node.after = parseIdArray(input.after, `${path}.after`);
  if (input.outputs !== undefined) node.outputs = parseStringArray(input.outputs, `${path}.outputs`);
  if (input.validators !== undefined) node.validators = parseStringArray(input.validators, `${path}.validators`);
  if (input.conflicts !== undefined) node.conflicts = parseConflicts(input.conflicts, `${path}.conflicts`);
  if (input.scope !== undefined) node.scope = requireNonEmptyString(input.scope, `${path}.scope`);
  if (input.kind !== undefined) node.kind = requireNonEmptyString(input.kind, `${path}.kind`);
  if (input.validation !== undefined) node.validation = parseValidationContract(input.validation, `${path}.validation`);
  if (input.workspaceStrategy !== undefined) node.workspaceStrategy = requireNonEmptyString(input.workspaceStrategy, `${path}.workspaceStrategy`);
  if (input.workspace !== undefined) node.workspace = parseWorkspaceBinding(input.workspace, `${path}.workspace`);
  if (input.risk !== undefined) node.risk = parseRisk(input.risk, `${path}.risk`);
  if (input.completionGates !== undefined) node.completionGates = parseStringArray(input.completionGates, `${path}.completionGates`);
  if (input.modelScenario !== undefined) node.modelScenario = requireNonEmptyString(input.modelScenario, `${path}.modelScenario`);
  if (input.thinkingLevel !== undefined) node.thinkingLevel = requireNonEmptyString(input.thinkingLevel, `${path}.thinkingLevel`);
  return node;
}

function parseWorkspaceBinding(input: unknown, path: string): GoalDagNode["workspace"] {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  assertKnownKeys(input, ["worktreeSlug", "branch", "baseRef"], path);
  const binding: NonNullable<GoalDagNode["workspace"]> = {};
  if (input.worktreeSlug !== undefined) binding.worktreeSlug = requireNonEmptyString(input.worktreeSlug, `${path}.worktreeSlug`);
  if (input.branch !== undefined) binding.branch = requireNonEmptyString(input.branch, `${path}.branch`);
  if (input.baseRef !== undefined) binding.baseRef = requireNonEmptyString(input.baseRef, `${path}.baseRef`);
  if (!binding.worktreeSlug && !binding.branch && !binding.baseRef) throw new Error(`Invalid goal DAG file: ${path} must set worktreeSlug, branch, or baseRef`);
  return binding;
}

function parseValidationContract(input: unknown, path: string): GoalDagValidationContract {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  assertKnownKeys(input, ["profile", "testSpecNodeId", "approvedByNodeId", "artifactLocks", "requiredEvidence", "onAuditTestGap", "diffBaseRef", "auditReportPaths", "allowedPaths", "forbiddenPaths"], path);
  const contract: GoalDagValidationContract = {};
  if (input.profile !== undefined) contract.profile = requireNonEmptyString(input.profile, `${path}.profile`);
  if (input.testSpecNodeId !== undefined) contract.testSpecNodeId = requireKebabId(input.testSpecNodeId, `${path}.testSpecNodeId`);
  if (input.approvedByNodeId !== undefined) contract.approvedByNodeId = requireKebabId(input.approvedByNodeId, `${path}.approvedByNodeId`);
  if (input.artifactLocks !== undefined) contract.artifactLocks = parseArtifactLocks(input.artifactLocks, `${path}.artifactLocks`);
  if (input.requiredEvidence !== undefined) contract.requiredEvidence = parseRequiredEvidence(input.requiredEvidence, `${path}.requiredEvidence`);
  if (input.onAuditTestGap !== undefined) contract.onAuditTestGap = requireNonEmptyString(input.onAuditTestGap, `${path}.onAuditTestGap`);
  if (input.diffBaseRef !== undefined) contract.diffBaseRef = requireNonEmptyString(input.diffBaseRef, `${path}.diffBaseRef`);
  if (input.auditReportPaths !== undefined) contract.auditReportPaths = parseStringArray(input.auditReportPaths, `${path}.auditReportPaths`);
  if (input.allowedPaths !== undefined) contract.allowedPaths = parseStringArray(input.allowedPaths, `${path}.allowedPaths`);
  if (input.forbiddenPaths !== undefined) contract.forbiddenPaths = parseStringArray(input.forbiddenPaths, `${path}.forbiddenPaths`);
  return contract;
}

function parseArtifactLocks(input: unknown, path: string): GoalValidationArtifactLock[] {
  if (!Array.isArray(input)) throw new Error(`Invalid goal DAG file: ${path} must be an array`);
  return input.map((item, index) => parseArtifactLock(item, `${path}[${index}]`));
}

function parseArtifactLock(input: unknown, path: string): GoalValidationArtifactLock {
  if (!isRecord(input)) throw new Error(`Invalid goal DAG file: ${path} must be an object`);
  assertKnownKeys(input, ["path", "sha256", "sourceNodeId", "approvedByNodeId", "approvedAt"], path);
  const lock: GoalValidationArtifactLock = {
    path: requireNonEmptyString(input.path, `${path}.path`),
    sha256: requireSha256(input.sha256, `${path}.sha256`),
  };
  if (input.sourceNodeId !== undefined) lock.sourceNodeId = requireKebabId(input.sourceNodeId, `${path}.sourceNodeId`);
  if (input.approvedByNodeId !== undefined) lock.approvedByNodeId = requireKebabId(input.approvedByNodeId, `${path}.approvedByNodeId`);
  if (input.approvedAt !== undefined) lock.approvedAt = requireNonEmptyString(input.approvedAt, `${path}.approvedAt`);
  return lock;
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
  assertKnownKeys(input, ["files", "modules", "capabilities"], path);
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

function parseRequiredEvidence(input: unknown, path: string): GoalValidationEvidenceRequirement[] {
  const values = parseStringArray(input, path);
  const unsupported = values.filter((v) => !isSupportedRequiredEvidence(v));
  if (unsupported.length > 0) {
    throw new Error(
      `Invalid goal DAG file: ${path} contains unsupported required evidence: ${unsupported.join(", ")}. ` +
      `Supported evidence tokens: ${SUPPORTED_REQUIRED_EVIDENCE.join(", ")}. ` +
      `Natural-language acceptance checks belong in validators, audit reports, objective/scope, path policy, or producer trace/review metadata.`,
    );
  }
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw new Error(`Invalid goal DAG file: ${path} contains duplicate required evidence: ${v}`);
    seen.add(v);
  }
  return values as GoalValidationEvidenceRequirement[];
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

function requireSha256(input: unknown, path: string): string {
  const value = requireNonEmptyString(input, path);
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`Invalid goal DAG file: ${path} must be a sha256 hex digest`);
  return value.toLowerCase();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function assertKnownKeys(input: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) throw new Error(`Invalid goal DAG file: ${path} has unsupported field ${key}`);
  }
}

function cloneConflictHints(hints: GoalDagConflictHints | undefined): GoalDagConflictHints | undefined {
  if (!hints) return undefined;
  return {
    files: hints.files ? [...hints.files] : undefined,
    modules: hints.modules ? [...hints.modules] : undefined,
    capabilities: hints.capabilities ? [...hints.capabilities] : undefined,
  };
}

function cloneWorkspaceBinding(binding: GoalDagNode["workspace"]): GoalDagNode["workspace"] {
  return binding ? { ...binding } : undefined;
}

function cloneValidationContract(contract: GoalDagValidationContract | undefined): GoalDagValidationContract | undefined {
  if (!contract) return undefined;
  return {
    ...contract,
    artifactLocks: contract.artifactLocks?.map((lock) => ({ ...lock })),
    requiredEvidence: contract.requiredEvidence ? [...contract.requiredEvidence] : undefined,
    auditReportPaths: contract.auditReportPaths ? [...contract.auditReportPaths] : undefined,
    allowedPaths: contract.allowedPaths ? [...contract.allowedPaths] : undefined,
    forbiddenPaths: contract.forbiddenPaths ? [...contract.forbiddenPaths] : undefined,
  };
}
