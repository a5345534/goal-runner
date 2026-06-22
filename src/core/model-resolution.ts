import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  evaluateGoalModelBindingCompliance,
  parseGoalModelBindingCatalogJson,
  parseGoalModelClassCatalogJson,
  type GoalModelBindingCatalog,
  type GoalModelClassCatalog,
  type GoalModelMinimumRequirements,
  type GoalModelResolution,
} from "goal-contract";

const require = createRequire(import.meta.url);

export interface GoalModelResolutionRequest {
  harness: string;
  role?: string;
  modelScenario?: string;
  modelClass: string;
  bindingSource?: string;
  classCatalog?: GoalModelClassCatalog;
  bindingCatalog?: GoalModelBindingCatalog;
}

export interface GoalModelResolutionResult {
  modelArg: string;
  evidence: GoalModelResolution;
}

const classCatalogCache = new Map<string, GoalModelClassCatalog>();
const bindingCatalogCache = new Map<string, GoalModelBindingCatalog>();

export function resolveGoalModelForHarness(request: GoalModelResolutionRequest): GoalModelResolutionResult {
  const classCatalog = request.classCatalog ?? readBundledModelClassCatalog();
  const bindingCatalog = request.bindingCatalog ?? readBundledModelBindingCatalog(request.harness);
  const modelClass = classCatalog.modelClasses[request.modelClass];
  if (!modelClass) {
    throw new Error(`Model resolution blocked: unknown modelClass ${JSON.stringify(request.modelClass)}`);
  }
  const binding = bindingCatalog.bindings[request.modelClass];
  if (!binding) {
    throw new Error(`Model resolution blocked: no ${bindingCatalog.harness} binding for modelClass ${JSON.stringify(request.modelClass)}`);
  }
  const compliance = evaluateGoalModelBindingCompliance(modelClass, binding);
  const evidence: GoalModelResolution = {
    schemaVersion: "1.0",
    harness: bindingCatalog.harness,
    requested: {
      ...(request.role ? { role: request.role } : {}),
      ...(request.modelScenario ? { modelScenario: request.modelScenario } : {}),
      modelClass: request.modelClass,
      minimumRequirements: { ...modelClass.minimumRequirements },
    },
    resolved: {
      model: binding.model,
      bindingSource: request.bindingSource ?? `goal-contract/catalogs/bindings/${bindingCatalog.harness}.json`,
    },
    compliance: {
      satisfiesMinimum: compliance.satisfiesMinimum,
      downgraded: compliance.downgraded,
      missingCapabilities: [...compliance.missingCapabilities],
    },
    status: compliance.status,
    ...(compliance.status === "resolved"
      ? {}
      : { reason: `binding does not satisfy minimum capabilities: ${compliance.missingCapabilities.join(", ") || "unknown"}` }),
  };

  if (evidence.status === "blocked") {
    throw new Error(`Model resolution blocked for ${request.modelClass}: ${evidence.reason ?? "binding is under-capable"}`);
  }
  return { modelArg: binding.model, evidence };
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

export function readBundledModelClassCatalog(): GoalModelClassCatalog {
  const specifier = "goal-contract/catalogs/model-classes.json";
  const cached = classCatalogCache.get(specifier);
  if (cached) return cached;
  const resolved = require.resolve(specifier);
  const catalog = parseGoalModelClassCatalogJson(readFileSync(resolved, "utf8"), specifier);
  classCatalogCache.set(specifier, catalog);
  return catalog;
}

export function readBundledModelBindingCatalog(harness: string): GoalModelBindingCatalog {
  const normalizedHarness = harness.trim() || "pi";
  const specifier = `goal-contract/catalogs/bindings/${normalizedHarness}.json`;
  const cached = bindingCatalogCache.get(specifier);
  if (cached) return cached;
  const resolved = require.resolve(specifier);
  const catalog = parseGoalModelBindingCatalogJson(readFileSync(resolved, "utf8"), specifier);
  bindingCatalogCache.set(specifier, catalog);
  return catalog;
}
