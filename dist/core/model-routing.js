const SCENARIO_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
export function parseGoalModelRoutingConfig(input, path = "modelRouting") {
    if (!isRecord(input))
        throw new Error(`Invalid goal model routing: ${path} must be an object`);
    if (!isRecord(input.scenarios))
        throw new Error(`Invalid goal model routing: ${path}.scenarios must be an object`);
    const scenarios = {};
    for (const [name, value] of Object.entries(input.scenarios)) {
        const scenarioId = requireScenarioId(name, `${path}.scenarios key`);
        if (!isRecord(value))
            throw new Error(`Invalid goal model routing: ${path}.scenarios.${name} must be an object`);
        const model = requireNonEmptyString(value.model, `${path}.scenarios.${name}.model`);
        const description = value.description === undefined ? undefined : requireNonEmptyString(value.description, `${path}.scenarios.${name}.description`);
        scenarios[scenarioId] = description ? { model, description } : { model };
    }
    if (Object.keys(scenarios).length === 0)
        throw new Error(`Invalid goal model routing: ${path}.scenarios must not be empty`);
    const controllerScenario = input.controllerScenario === undefined
        ? undefined
        : requireKnownScenario(input.controllerScenario, scenarios, `${path}.controllerScenario`);
    const defaultSubagentScenario = input.defaultSubagentScenario === undefined
        ? undefined
        : requireKnownScenario(input.defaultSubagentScenario, scenarios, `${path}.defaultSubagentScenario`);
    const rules = input.rules === undefined ? undefined : parseRules(input.rules, scenarios, `${path}.rules`);
    return { scenarios, controllerScenario, defaultSubagentScenario, rules };
}
export function parseGoalModelRoutingConfigJson(json, path = "modelRouting") {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch (error) {
        throw new Error(`Invalid goal model routing JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseGoalModelRoutingConfig(parsed, path);
}
export function resolveControllerModelArg(config, fallbackModelArg) {
    if (!config?.controllerScenario)
        return { model: fallbackModelArg, reason: "fallback controller model" };
    const scenario = config.scenarios[config.controllerScenario];
    return {
        scenario: config.controllerScenario,
        model: scenario?.model ?? fallbackModelArg,
        reason: scenario ? `controllerScenario:${config.controllerScenario}` : "fallback controller model",
    };
}
export function selectModelScenarioForNode(node, config, fallbackModelArg) {
    if (!config)
        return { model: fallbackModelArg, reason: "fallback subagent model" };
    if (node.modelScenario) {
        const scenario = config.scenarios[node.modelScenario];
        return {
            scenario: node.modelScenario,
            model: scenario?.model ?? fallbackModelArg,
            reason: scenario ? `node.modelScenario:${node.modelScenario}` : "fallback subagent model",
        };
    }
    for (const rule of config.rules ?? []) {
        if (!matchesRule(node, rule.when))
            continue;
        const scenario = config.scenarios[rule.scenario];
        return {
            scenario: rule.scenario,
            model: scenario?.model ?? fallbackModelArg,
            reason: scenario ? `rule:${rule.scenario}` : "fallback subagent model",
        };
    }
    if (config.defaultSubagentScenario) {
        const scenario = config.scenarios[config.defaultSubagentScenario];
        return {
            scenario: config.defaultSubagentScenario,
            model: scenario?.model ?? fallbackModelArg,
            reason: scenario ? `defaultSubagentScenario:${config.defaultSubagentScenario}` : "fallback subagent model",
        };
    }
    return { model: fallbackModelArg, reason: "fallback subagent model" };
}
export function assertKnownModelScenario(config, scenario, path) {
    if (!config)
        return;
    if (!config.scenarios[scenario])
        throw new Error(`Invalid goal model routing: ${path} references unknown scenario ${scenario}`);
}
function parseRules(input, scenarios, path) {
    if (!Array.isArray(input))
        throw new Error(`Invalid goal model routing: ${path} must be an array`);
    return input.map((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isRecord(item))
            throw new Error(`Invalid goal model routing: ${itemPath} must be an object`);
        const scenario = requireKnownScenario(item.scenario, scenarios, `${itemPath}.scenario`);
        const when = item.when === undefined ? undefined : parseRuleMatch(item.when, `${itemPath}.when`);
        return when ? { scenario, when } : { scenario };
    });
}
function parseRuleMatch(input, path) {
    if (!isRecord(input))
        throw new Error(`Invalid goal model routing: ${path} must be an object`);
    const match = {};
    if (input.nodeIds !== undefined)
        match.nodeIds = parseStringArray(input.nodeIds, `${path}.nodeIds`);
    if (input.scopes !== undefined)
        match.scopes = parseStringArray(input.scopes, `${path}.scopes`);
    if (input.risks !== undefined)
        match.risks = parseRiskArray(input.risks, `${path}.risks`);
    if (input.modules !== undefined)
        match.modules = parseStringArray(input.modules, `${path}.modules`);
    if (input.capabilities !== undefined)
        match.capabilities = parseStringArray(input.capabilities, `${path}.capabilities`);
    if (input.files !== undefined)
        match.files = parseStringArray(input.files, `${path}.files`);
    if (input.objectiveIncludes !== undefined)
        match.objectiveIncludes = parseStringArray(input.objectiveIncludes, `${path}.objectiveIncludes`);
    if (input.hasValidators !== undefined)
        match.hasValidators = requireBoolean(input.hasValidators, `${path}.hasValidators`);
    if (input.hasOutputs !== undefined)
        match.hasOutputs = requireBoolean(input.hasOutputs, `${path}.hasOutputs`);
    return match;
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
    if (when.modules && !hasAny(node.conflictHints?.modules, when.modules))
        return false;
    if (when.capabilities && !hasAny(node.conflictHints?.capabilities, when.capabilities))
        return false;
    if (when.files && !hasAny(node.conflictHints?.files, when.files))
        return false;
    if (when.objectiveIncludes && !when.objectiveIncludes.some((needle) => node.objective.toLowerCase().includes(needle.toLowerCase())))
        return false;
    if (when.hasValidators !== undefined && (node.validators.length > 0) !== when.hasValidators)
        return false;
    if (when.hasOutputs !== undefined && (node.expectedOutputs.length > 0) !== when.hasOutputs)
        return false;
    return true;
}
function hasAny(values, candidates) {
    return Boolean(values?.some((value) => candidates.includes(value)));
}
function requireKnownScenario(input, scenarios, path) {
    const scenario = requireScenarioId(input, path);
    if (!scenarios[scenario])
        throw new Error(`Invalid goal model routing: ${path} references unknown scenario ${scenario}`);
    return scenario;
}
function requireScenarioId(input, path) {
    const value = requireNonEmptyString(input, path);
    if (!SCENARIO_ID_PATTERN.test(value))
        throw new Error(`Invalid goal model routing: ${path} must match ${SCENARIO_ID_PATTERN.source}`);
    return value;
}
function parseStringArray(input, path) {
    if (!Array.isArray(input))
        throw new Error(`Invalid goal model routing: ${path} must be an array`);
    return input.map((item, index) => requireNonEmptyString(item, `${path}[${index}]`));
}
function parseRiskArray(input, path) {
    return parseStringArray(input, path).map((item) => {
        if (item === "low" || item === "medium" || item === "high")
            return item;
        throw new Error(`Invalid goal model routing: ${path} contains invalid risk ${item}`);
    });
}
function requireBoolean(input, path) {
    if (typeof input !== "boolean")
        throw new Error(`Invalid goal model routing: ${path} must be boolean`);
    return input;
}
function requireNonEmptyString(input, path) {
    if (typeof input !== "string" || !input.trim())
        throw new Error(`Invalid goal model routing: ${path} must be a non-empty string`);
    return input.trim();
}
function isRecord(input) {
    return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
//# sourceMappingURL=model-routing.js.map