// Model routing helpers for the opencode adapter.
//
// The opencode adapter picks a model for both the controller loop and the
// subagent per-DAG-node based on the same `GoalModelRoutingConfig` the Pi
// adapter consumes. The routing config can be supplied inline through
// `/goal --model-routing <json>`, through `/goal --model-routing-file
// <path>`, or through the `AGENT_GOAL_MODEL_ROUTING_FILE` /
// `AGENT_GOAL_MODEL_ROUTING_JSON` env vars. The fallback model comes from
// the opencode session's current model (when the runtime provides it).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGoalModelRoutingConfigJson, selectModelScenarioForNode, } from "../../core/index.js";
/** Read the model routing config from the supplied inline JSON/file/env precedence chain. */
export function readOpencodeModelRoutingConfig(input) {
    const env = input.env ?? process.env;
    if (input.filePath?.trim()) {
        const resolved = resolve(input.cwd ?? process.cwd(), input.filePath.trim());
        return parseGoalModelRoutingConfigJson(readFileSync(resolved, "utf8"), `AGENT_GOAL_MODEL_ROUTING_FILE:${resolved}`);
    }
    if (input.inlineJson?.trim()) {
        return parseGoalModelRoutingConfigJson(input.inlineJson, "AGENT_GOAL_MODEL_ROUTING_INLINE");
    }
    const envFile = env.AGENT_GOAL_MODEL_ROUTING_FILE;
    if (envFile?.trim() && existsSync(resolve(input.cwd ?? process.cwd(), envFile.trim()))) {
        const resolved = resolve(input.cwd ?? process.cwd(), envFile.trim());
        return parseGoalModelRoutingConfigJson(readFileSync(resolved, "utf8"), `AGENT_GOAL_MODEL_ROUTING_FILE:${resolved}`);
    }
    const envJson = env.AGENT_GOAL_MODEL_ROUTING_JSON;
    if (envJson?.trim())
        return parseGoalModelRoutingConfigJson(envJson, "AGENT_GOAL_MODEL_ROUTING_JSON");
    return undefined;
}
/**
 * Pick a subagent model for an opencode DAG node. The opencode adapter
 * does not have a host-level model registry, so the "current model" is
 * provided by the caller (typically the opencode session model passed in
 * through `ctx`).
 */
export function selectOpencodeSubagentModel(node, modelRouting, fallbackModelArg) {
    if (node.modelArg) {
        return {
            scenario: node.modelScenario,
            model: node.modelArg,
            reason: node.modelScenario ? `persisted node modelScenario:${node.modelScenario}` : "persisted node modelArg",
        };
    }
    return selectModelScenarioForNode(node, modelRouting, fallbackModelArg);
}
/**
 * Resolve the controller model. The controller can use a model-routing
 * scenario (when `controllerScenario` is set) or fall back to the opencode
 * session's current model.
 */
export function resolveOpencodeControllerModel(modelRouting, fallbackModelArg) {
    const scenario = modelRouting?.controllerScenario;
    if (scenario && modelRouting?.scenarios?.[scenario]) {
        return { scenario, model: modelRouting.scenarios[scenario].model, reason: `controller scenario:${scenario}` };
    }
    return { model: fallbackModelArg, reason: fallbackModelArg ? "opencode session model" : "no controller model configured" };
}
/** Resolve the opencode session's current model from the opencode plugin context. */
export function modelArgFromOpencodeContext(ctx) {
    const m = ctx.model;
    if (typeof m === "string")
        return m;
    if (!m)
        return undefined;
    const provider = m.providerID ?? m.providerId;
    const modelId = m.modelID ?? m.modelId ?? m.id;
    if (typeof provider === "string" && typeof modelId === "string" && provider && modelId)
        return `${provider}/${modelId}`;
    return undefined;
}
//# sourceMappingURL=model-routing.js.map