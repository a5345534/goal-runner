import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  evaluateGoalModelBindingCompliance,
  evaluateGoalModelResolutionCandidates,
  getGoalModelBindingCandidates,
  normalizeGoalModelBindingCatalog,
  parseGoalModelBindingCatalogJson,
  parseGoalModelClassCatalogJson,
  type GoalModelBinding,
  type GoalModelBindingCatalog,
  type GoalModelClassCatalog,
  type GoalModelMinimumRequirements,
  type GoalModelNormalizedBindingCatalog,
  type GoalModelResolution,
} from "goal-contract";

const require = createRequire(import.meta.url);

const MODEL_CLASS_CATALOG_SPECIFIER = "goal-contract/catalogs/model-classes.json";

export interface GoalModelResolutionRequest {
  harness: string;
  role?: string;
  modelScenario?: string;
  modelClass: string;
  bindingSource?: string;
  classCatalog?: GoalModelClassCatalog;
  bindingCatalog?: GoalModelBindingCatalog;
  env?: NodeJS.ProcessEnv;
}

export interface GoalModelResolutionResult {
  modelArg: string;
  evidence: GoalModelResolution;
}

interface LoadedModelClassCatalog {
  catalog: GoalModelClassCatalog;
  source: string;
}

interface LoadedModelBindingCatalog {
  /** Raw (v1 or v2) binding catalog used for candidate chain evaluation. */
  rawCatalog: GoalModelBindingCatalog;
  /** Normalized binding catalog with uniform `candidates[]` access. */
  normalizedCatalog: GoalModelNormalizedBindingCatalog;
  source: string;
}

const classCatalogCache = new Map<string, GoalModelClassCatalog>();
const bindingCatalogCache = new Map<string, GoalModelBindingCatalog>();

export function resolveGoalModelForHarness(request: GoalModelResolutionRequest): GoalModelResolutionResult {
  const classCatalog = request.classCatalog ?? loadModelClassCatalogFromEnvOrBundled(request.env).catalog;
  const bindingLoad = request.bindingCatalog
    ? {
        rawCatalog: request.bindingCatalog,
        normalizedCatalog: normalizeGoalModelBindingCatalog(request.bindingCatalog),
        source: request.bindingSource ?? "provided binding catalog",
      }
    : loadModelBindingCatalogFromEnvOrBundled(request.harness, request.env);
  const rawCatalog = bindingLoad.rawCatalog;
  const normalizedCatalog = bindingLoad.normalizedCatalog;
  const expectedHarness = normalizeHarness(request.harness);
  if (normalizedCatalog.harness !== expectedHarness) {
    throw new Error(
      `Model resolution blocked: binding catalog harness ${JSON.stringify(normalizedCatalog.harness)} does not match requested harness ${JSON.stringify(expectedHarness)}`,
    );
  }

  const modelClass = classCatalog.modelClasses[request.modelClass];
  if (!modelClass) {
    throw new Error(`Model resolution blocked: unknown modelClass ${JSON.stringify(request.modelClass)}`);
  }

  const rawBinding: GoalModelBinding | undefined = rawCatalog.bindings[request.modelClass];
  if (!rawBinding) {
    throw new Error(`Model resolution blocked: no ${normalizedCatalog.harness} binding for modelClass ${JSON.stringify(request.modelClass)}`);
  }

  const normalizedBinding = normalizedCatalog.bindings[request.modelClass]!;
  const firstCandidate = normalizedBinding.candidates[0]!;

  // Evaluate candidate chain using the contract's first-match-wins fallback logic
  const candidateEvaluation = evaluateGoalModelResolutionCandidates(modelClass, rawBinding);
  const resolvedIndex = candidateEvaluation.resolvedCandidateIndex;
  const resolved = resolvedIndex !== undefined ? normalizedBinding.candidates[resolvedIndex] : firstCandidate;

  // Determine the final compliance status from the resolved candidate
  const resolvedCompliance = resolvedIndex !== undefined
    ? candidateEvaluation.attemptedCandidates[resolvedIndex]!.compliance
    : candidateEvaluation.attemptedCandidates[0]?.compliance ?? { satisfiesMinimum: false, downgraded: false, missingCapabilities: [] };

  const status: GoalModelResolution["status"] =
    resolvedIndex !== undefined
      ? (resolvedCompliance.satisfiesMinimum ? "resolved" : "warn")
      : "blocked";

  const evidence: GoalModelResolution = {
    schemaVersion: "1.0",
    harness: normalizedCatalog.harness,
    requested: {
      ...(request.role ? { role: request.role } : {}),
      ...(request.modelScenario ? { modelScenario: request.modelScenario } : {}),
      modelClass: request.modelClass,
      minimumRequirements: { ...modelClass.minimumRequirements },
    },
    resolved: {
      model: resolved.model,
      bindingSource: request.bindingSource ?? bindingLoad.source,
      ...(resolvedIndex !== undefined ? { candidateIndex: resolvedIndex } : {}),
    },
    compliance: {
      satisfiesMinimum: resolvedCompliance.satisfiesMinimum,
      downgraded: resolvedCompliance.downgraded,
      missingCapabilities: [...resolvedCompliance.missingCapabilities],
    },
    attemptedCandidates: candidateEvaluation.attemptedCandidates.length > 0
      ? candidateEvaluation.attemptedCandidates
      : undefined,
    switchEvents: candidateEvaluation.switchEvents.length > 0
      ? candidateEvaluation.switchEvents
      : undefined,
    candidatePlan: candidateEvaluation.candidatePlan.length > 0
      ? candidateEvaluation.candidatePlan
      : undefined,
    retryPolicy: candidateEvaluation.retryPolicy,
    exhaustedChain: candidateEvaluation.exhaustedChain || undefined,
    status,
    ...(status === "resolved" ? {} : { reason: buildBlockedReason(candidateEvaluation) }),
  };

  if (evidence.status === "blocked") {
    throw new Error(`Model resolution blocked for ${request.modelClass}: ${evidence.reason ?? "no eligible candidate"}`);
  }

  return { modelArg: resolved.model, evidence };
}

function buildBlockedReason(candidateEvaluation: {
  attemptedCandidates: Array<{ compliance: { missingCapabilities: string[] }; status: string; reason?: string }>;
  exhaustedChain: boolean;
}): string {
  if (candidateEvaluation.exhaustedChain) {
    return `all candidates exhausted: ${candidateEvaluation.attemptedCandidates.map((a) => a.reason ?? a.status).join("; ")}`;
  }
  const lastAttempt = candidateEvaluation.attemptedCandidates[candidateEvaluation.attemptedCandidates.length - 1];
  if (lastAttempt) {
    return `binding does not satisfy minimum capabilities: ${lastAttempt.compliance.missingCapabilities.join(", ") || "unknown"}`;
  }
  return "no eligible candidate";
}

export function buildBlockedGoalModelResolutionEvidence(input: {
  harness: string;
  role?: string;
  modelScenario?: string;
  modelClass: string;
  minimumRequirements?: GoalModelMinimumRequirements;
  reason: string;
}): GoalModelResolution {
  return {
    schemaVersion: "1.0",
    harness: input.harness,
    requested: {
      ...(input.role ? { role: input.role } : {}),
      ...(input.modelScenario ? { modelScenario: input.modelScenario } : {}),
      modelClass: input.modelClass,
      minimumRequirements: input.minimumRequirements ?? {},
    },
    compliance: {
      satisfiesMinimum: false,
      downgraded: false,
      missingCapabilities: [],
    },
    status: "blocked",
    reason: input.reason,
  };
}

export function readModelClassCatalogFromEnvOrBundled(env: NodeJS.ProcessEnv = process.env): GoalModelClassCatalog {
  return loadModelClassCatalogFromEnvOrBundled(env).catalog;
}

export function readModelBindingCatalogFromEnvOrBundled(
  harness: string,
  env: NodeJS.ProcessEnv = process.env,
): GoalModelNormalizedBindingCatalog {
  return loadModelBindingCatalogFromEnvOrBundled(harness, env).normalizedCatalog;
}

export function readBundledModelClassCatalog(): GoalModelClassCatalog {
  const cached = classCatalogCache.get(MODEL_CLASS_CATALOG_SPECIFIER);
  if (cached) return cached;
  const resolved = require.resolve(MODEL_CLASS_CATALOG_SPECIFIER);
  const catalog = parseGoalModelClassCatalogJson(readFileSync(resolved, "utf8"), MODEL_CLASS_CATALOG_SPECIFIER);
  classCatalogCache.set(MODEL_CLASS_CATALOG_SPECIFIER, catalog);
  return catalog;
}

export function readBundledModelBindingCatalog(harness: string): GoalModelNormalizedBindingCatalog {
  const normalizedHarness = normalizeHarness(harness);
  const specifier = `goal-runner/catalogs/bindings/${normalizedHarness}.json`;
  const cached = bindingCatalogCache.get(specifier);
  if (cached) {
    return normalizeGoalModelBindingCatalog(cached);
  }
  let resolved: string;
  try {
    resolved = require.resolve(specifier);
  } catch (error) {
    throw new Error(
      `Model resolution blocked: no bundled binding catalog for harness ${JSON.stringify(normalizedHarness)} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const catalog = parseGoalModelBindingCatalogJson(readFileSync(resolved, "utf8"), specifier);
  bindingCatalogCache.set(specifier, catalog);
  return normalizeGoalModelBindingCatalog(catalog);
}

function loadModelClassCatalogFromEnvOrBundled(env: NodeJS.ProcessEnv | undefined): LoadedModelClassCatalog {
  const catalogFile = env?.AGENT_GOAL_MODEL_CLASS_CATALOG_FILE;
  if (catalogFile?.trim()) {
    const resolved = resolve(process.cwd(), catalogFile.trim());
    if (!existsSync(resolved)) {
      throw new Error(`Model resolution blocked: AGENT_GOAL_MODEL_CLASS_CATALOG_FILE not found: ${resolved}`);
    }
    const source = `AGENT_GOAL_MODEL_CLASS_CATALOG_FILE:${resolved}`;
    return { catalog: parseGoalModelClassCatalogJson(readFileSync(resolved, "utf8"), source), source };
  }

  const catalogJson = env?.AGENT_GOAL_MODEL_CLASS_CATALOG_JSON;
  if (catalogJson?.trim()) {
    const source = "AGENT_GOAL_MODEL_CLASS_CATALOG_JSON";
    return { catalog: parseGoalModelClassCatalogJson(catalogJson, source), source };
  }

  return { catalog: readBundledModelClassCatalog(), source: MODEL_CLASS_CATALOG_SPECIFIER };
}

function loadModelBindingCatalogFromEnvOrBundled(
  harness: string,
  env: NodeJS.ProcessEnv | undefined,
): LoadedModelBindingCatalog {
  const normalizedHarness = normalizeHarness(harness);
  const bindingFile = env?.AGENT_GOAL_MODEL_BINDING_FILE;
  if (bindingFile?.trim()) {
    const resolved = resolve(process.cwd(), bindingFile.trim());
    if (!existsSync(resolved)) {
      throw new Error(`Model resolution blocked: AGENT_GOAL_MODEL_BINDING_FILE not found: ${resolved}`);
    }
    const source = `AGENT_GOAL_MODEL_BINDING_FILE:${resolved}`;
    const rawCatalog = parseGoalModelBindingCatalogJson(readFileSync(resolved, "utf8"), source);
    return {
      rawCatalog: assertBindingCatalogHarness(rawCatalog, normalizedHarness, source),
      normalizedCatalog: normalizeGoalModelBindingCatalog(rawCatalog),
      source,
    };
  }

  const bindingJson = env?.AGENT_GOAL_MODEL_BINDING_JSON;
  if (bindingJson?.trim()) {
    const source = "AGENT_GOAL_MODEL_BINDING_JSON";
    const rawCatalog = parseGoalModelBindingCatalogJson(bindingJson, source);
    return {
      rawCatalog: assertBindingCatalogHarness(rawCatalog, normalizedHarness, source),
      normalizedCatalog: normalizeGoalModelBindingCatalog(rawCatalog),
      source,
    };
  }

  const source = `goal-runner/catalogs/bindings/${normalizedHarness}.json`;
  const rawCatalog = assertBindingCatalogHarness(
    loadRawBundledModelBindingCatalog(normalizedHarness),
    normalizedHarness,
    source,
  );
  return {
    rawCatalog,
    normalizedCatalog: normalizeGoalModelBindingCatalog(rawCatalog),
    source,
  };
}

function loadRawBundledModelBindingCatalog(harness: string): GoalModelBindingCatalog {
  const normalizedHarness = normalizeHarness(harness);
  const specifier = `goal-runner/catalogs/bindings/${normalizedHarness}.json`;
  const cached = bindingCatalogCache.get(specifier);
  if (cached) return cached;
  let resolved: string;
  try {
    resolved = require.resolve(specifier);
  } catch (error) {
    throw new Error(
      `Model resolution blocked: no bundled binding catalog for harness ${JSON.stringify(normalizedHarness)} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const catalog = parseGoalModelBindingCatalogJson(readFileSync(resolved, "utf8"), specifier);
  bindingCatalogCache.set(specifier, catalog);
  return catalog;
}

function assertBindingCatalogHarness(
  catalog: GoalModelBindingCatalog,
  expectedHarness: string,
  source: string,
): GoalModelBindingCatalog {
  if (catalog.harness !== expectedHarness) {
    throw new Error(
      `Model resolution blocked: binding catalog ${source} harness ${JSON.stringify(catalog.harness)} does not match requested harness ${JSON.stringify(expectedHarness)}`,
    );
  }
  return catalog;
}

function normalizeHarness(harness: string): string {
  return harness.trim() || "pi";
}
