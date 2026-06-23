import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { evaluateGoalModelBindingCompliance, parseGoalModelBindingCatalogJson, parseGoalModelClassCatalogJson, } from "goal-contract";
const require = createRequire(import.meta.url);
const MODEL_CLASS_CATALOG_SPECIFIER = "goal-contract/catalogs/model-classes.json";
const classCatalogCache = new Map();
const bindingCatalogCache = new Map();
export function resolveGoalModelForHarness(request) {
    const classCatalog = request.classCatalog ?? loadModelClassCatalogFromEnvOrBundled(request.env).catalog;
    const bindingLoad = request.bindingCatalog
        ? { catalog: request.bindingCatalog, source: request.bindingSource ?? "provided binding catalog" }
        : loadModelBindingCatalogFromEnvOrBundled(request.harness, request.env);
    const bindingCatalog = bindingLoad.catalog;
    const expectedHarness = normalizeHarness(request.harness);
    if (bindingCatalog.harness !== expectedHarness) {
        throw new Error(`Model resolution blocked: binding catalog harness ${JSON.stringify(bindingCatalog.harness)} does not match requested harness ${JSON.stringify(expectedHarness)}`);
    }
    const modelClass = classCatalog.modelClasses[request.modelClass];
    if (!modelClass) {
        throw new Error(`Model resolution blocked: unknown modelClass ${JSON.stringify(request.modelClass)}`);
    }
    const binding = bindingCatalog.bindings[request.modelClass];
    if (!binding) {
        throw new Error(`Model resolution blocked: no ${bindingCatalog.harness} binding for modelClass ${JSON.stringify(request.modelClass)}`);
    }
    const compliance = evaluateGoalModelBindingCompliance(modelClass, binding);
    const evidence = {
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
            bindingSource: request.bindingSource ?? bindingLoad.source,
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
export function buildBlockedGoalModelResolutionEvidence(input) {
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
export function readModelClassCatalogFromEnvOrBundled(env = process.env) {
    return loadModelClassCatalogFromEnvOrBundled(env).catalog;
}
export function readModelBindingCatalogFromEnvOrBundled(harness, env = process.env) {
    return loadModelBindingCatalogFromEnvOrBundled(harness, env).catalog;
}
export function readBundledModelClassCatalog() {
    const cached = classCatalogCache.get(MODEL_CLASS_CATALOG_SPECIFIER);
    if (cached)
        return cached;
    const resolved = require.resolve(MODEL_CLASS_CATALOG_SPECIFIER);
    const catalog = parseGoalModelClassCatalogJson(readFileSync(resolved, "utf8"), MODEL_CLASS_CATALOG_SPECIFIER);
    classCatalogCache.set(MODEL_CLASS_CATALOG_SPECIFIER, catalog);
    return catalog;
}
export function readBundledModelBindingCatalog(harness) {
    const normalizedHarness = normalizeHarness(harness);
    const specifier = `goal-runner/catalogs/bindings/${normalizedHarness}.json`;
    const cached = bindingCatalogCache.get(specifier);
    if (cached)
        return cached;
    let resolved;
    try {
        resolved = require.resolve(specifier);
    }
    catch (error) {
        throw new Error(`Model resolution blocked: no bundled binding catalog for harness ${JSON.stringify(normalizedHarness)} (${error instanceof Error ? error.message : String(error)})`);
    }
    const catalog = parseGoalModelBindingCatalogJson(readFileSync(resolved, "utf8"), specifier);
    bindingCatalogCache.set(specifier, catalog);
    return catalog;
}
function loadModelClassCatalogFromEnvOrBundled(env) {
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
function loadModelBindingCatalogFromEnvOrBundled(harness, env) {
    const normalizedHarness = normalizeHarness(harness);
    const bindingFile = env?.AGENT_GOAL_MODEL_BINDING_FILE;
    if (bindingFile?.trim()) {
        const resolved = resolve(process.cwd(), bindingFile.trim());
        if (!existsSync(resolved)) {
            throw new Error(`Model resolution blocked: AGENT_GOAL_MODEL_BINDING_FILE not found: ${resolved}`);
        }
        const source = `AGENT_GOAL_MODEL_BINDING_FILE:${resolved}`;
        const catalog = parseGoalModelBindingCatalogJson(readFileSync(resolved, "utf8"), source);
        return { catalog: assertBindingCatalogHarness(catalog, normalizedHarness, source), source };
    }
    const bindingJson = env?.AGENT_GOAL_MODEL_BINDING_JSON;
    if (bindingJson?.trim()) {
        const source = "AGENT_GOAL_MODEL_BINDING_JSON";
        const catalog = parseGoalModelBindingCatalogJson(bindingJson, source);
        return { catalog: assertBindingCatalogHarness(catalog, normalizedHarness, source), source };
    }
    const source = `goal-runner/catalogs/bindings/${normalizedHarness}.json`;
    return {
        catalog: assertBindingCatalogHarness(readBundledModelBindingCatalog(normalizedHarness), normalizedHarness, source),
        source,
    };
}
function assertBindingCatalogHarness(catalog, expectedHarness, source) {
    if (catalog.harness !== expectedHarness) {
        throw new Error(`Model resolution blocked: binding catalog ${source} harness ${JSON.stringify(catalog.harness)} does not match requested harness ${JSON.stringify(expectedHarness)}`);
    }
    return catalog;
}
function normalizeHarness(harness) {
    return harness.trim() || "pi";
}
//# sourceMappingURL=model-resolution.js.map