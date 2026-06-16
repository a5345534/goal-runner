import { parseGoalModelRoutingConfig, parseGoalModelRoutingConfigJson, } from "goal-contract";
export { parseGoalModelRoutingConfig, parseGoalModelRoutingConfigJson };
export function resolveControllerModelArg(config, fallbackModelArg) {
    if (config?.controllerScenario && config.scenarios[config.controllerScenario]) {
        return {
            scenario: config.controllerScenario,
            model: config.scenarios[config.controllerScenario].model,
            reason: `controller scenario ${config.controllerScenario}`,
        };
    }
    return { scenario: undefined, model: fallbackModelArg, reason: "fallback controller model" };
}
export function selectModelScenarioForNode(node, config, fallbackModelArg) {
    if (!config)
        return { model: fallbackModelArg, reason: "fallback subagent model" };
    if (node.modelScenario && config.scenarios[node.modelScenario]) {
        return { scenario: node.modelScenario, model: config.scenarios[node.modelScenario].model, reason: `explicit node modelScenario ${node.modelScenario}` };
    }
    if (config.rules) {
        for (const rule of config.rules) {
            if (matchesRule(node, rule.when)) {
                return { scenario: rule.scenario, model: config.scenarios[rule.scenario]?.model ?? fallbackModelArg, reason: `routing rule ${rule.scenario}` };
            }
        }
    }
    if (config.defaultSubagentScenario && config.scenarios[config.defaultSubagentScenario]) {
        return {
            scenario: config.defaultSubagentScenario,
            model: config.scenarios[config.defaultSubagentScenario].model,
            reason: `default subagent scenario ${config.defaultSubagentScenario}`,
        };
    }
    return { scenario: undefined, model: fallbackModelArg, reason: "no routing config match" };
}
export function assertKnownModelScenario(config, scenario, path) {
    if (!config || !(scenario in (config.scenarios ?? {}))) {
        throw new Error(`Invalid goal DAG file: ${path} modelScenario references unknown scenario ${JSON.stringify(scenario)}`);
    }
}
function matchesRule(node, when) {
    if (!when)
        return true;
    if (when.nodeIds && !when.nodeIds.includes(node.nodeId))
        return false;
    if (when.scopes && (!node.scope || !when.scopes.includes(node.scope)))
        return false;
    if (when.risks && (!node.risk || !when.risks.includes(node.risk)))
        return false;
    if (when.modules && (!node.conflictHints?.modules || !when.modules.some((m) => node.conflictHints.modules.includes(m))))
        return false;
    if (when.capabilities && (!node.conflictHints?.capabilities || !when.capabilities.some((c) => node.conflictHints.capabilities.includes(c))))
        return false;
    if (when.files && (!node.conflictHints?.files || !when.files.some((f) => node.conflictHints.files.includes(f))))
        return false;
    if (when.objectiveIncludes && !when.objectiveIncludes.some((t) => node.objective.toLowerCase().includes(t.toLowerCase())))
        return false;
    if (when.hasValidators !== undefined && (node.validators.length > 0) !== when.hasValidators)
        return false;
    if (when.hasOutputs !== undefined && (node.expectedOutputs.length > 0) !== when.hasOutputs)
        return false;
    return true;
}
//# sourceMappingURL=model-routing.js.map