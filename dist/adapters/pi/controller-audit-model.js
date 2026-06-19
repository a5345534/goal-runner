import { renderControllerAuditPrompt } from "../../core/prompts.js";
const BOOLEAN_TRUE = new Set(["1", "true", "on", "yes", "enabled"]);
const BOOLEAN_FALSE = new Set(["0", "false", "off", "no", "disabled"]);
function resolveEnv(names) {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value.trim() !== "") {
            return { name, value: value.trim() };
        }
    }
    return undefined;
}
function parseBoolean(value, defaultValue) {
    if (!value)
        return defaultValue;
    const normalized = value.value.toLowerCase();
    if (BOOLEAN_TRUE.has(normalized))
        return true;
    if (BOOLEAN_FALSE.has(normalized))
        return false;
    throw new Error(`Invalid boolean value for ${value.name}: ${value.value}`);
}
function parseIntEnv(value, min, defaultValue) {
    if (!value)
        return defaultValue;
    const parsed = Number.parseInt(value.value, 10);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error(`Invalid integer value for ${value.name}: ${value.value}`);
    }
    if (parsed < min) {
        throw new Error(`Invalid value for ${value.name}: ${value.value} (must be >= ${min})`);
    }
    return parsed;
}
function truncate(value, maxChars) {
    return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
function normalizeChatCompletionsEndpoint(raw) {
    const trimmed = raw.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(trimmed))
        return trimmed;
    return `${trimmed}/chat/completions`;
}
export function controllerAuditOptions() {
    const enabledEnv = resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT",
        "PI_GOAL_CONTROLLER_AUDIT",
    ]);
    const enabled = parseBoolean(enabledEnv, false);
    if (!enabled) {
        return { enabled: false };
    }
    const intervalMs = parseIntEnv(resolveEnv(["AGENT_GOAL_CONTROLLER_AUDIT_INTERVAL_MS", "AGENT_GOAL_PI_CONTROLLER_AUDIT_INTERVAL_MS", "PI_GOAL_CONTROLLER_AUDIT_INTERVAL_MS"]), 1, undefined);
    const maxRecentEvents = parseIntEnv(resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_MAX_RECENT_EVENTS",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_MAX_RECENT_EVENTS",
        "PI_GOAL_CONTROLLER_AUDIT_MAX_RECENT_EVENTS",
    ]), 1, undefined);
    const maxRecentValidationResults = parseIntEnv(resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_MAX_RECENT_VALIDATION_RESULTS",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_MAX_RECENT_VALIDATION_RESULTS",
        "PI_GOAL_CONTROLLER_AUDIT_MAX_RECENT_VALIDATION_RESULTS",
    ]), 1, undefined);
    const maxTokensPerAudit = parseIntEnv(resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_MAX_TOKENS_PER_AUDIT",
        "AGENT_GOAL_CONTROLLER_AUDIT_MAX_TOKENS",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_MAX_TOKENS_PER_AUDIT",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_MAX_TOKENS",
        "PI_GOAL_CONTROLLER_AUDIT_MAX_TOKENS_PER_AUDIT",
        "PI_GOAL_CONTROLLER_AUDIT_MAX_TOKENS",
    ]), 1, undefined);
    const pauseOnCritical = parseBoolean(resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_PAUSE_ON_CRITICAL",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_PAUSE_ON_CRITICAL",
        "PI_GOAL_CONTROLLER_AUDIT_PAUSE_ON_CRITICAL",
    ]), true);
    const includeTranscriptExcerpts = parseBoolean(resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_INCLUDE_TRANSCRIPT_EXCERPTS",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_INCLUDE_TRANSCRIPT_EXCERPTS",
        "PI_GOAL_CONTROLLER_AUDIT_INCLUDE_TRANSCRIPT_EXCERPTS",
    ]), false);
    return {
        enabled: true,
        intervalMs,
        maxRecentEvents,
        maxRecentValidationResults,
        maxTokensPerAudit,
        pauseOnCritical,
        includeTranscriptExcerpts,
    };
}
function resolveChatCompletionConfig() {
    const model = resolveEnv(["AGENT_GOAL_CONTROLLER_AUDIT_MODEL", "AGENT_GOAL_PI_CONTROLLER_AUDIT_MODEL", "PI_GOAL_CONTROLLER_AUDIT_MODEL"]);
    if (!model) {
        throw new Error("Missing required controller-audit model configuration: set AGENT_GOAL_CONTROLLER_AUDIT_MODEL (or PI/AGENT_GOAL_PI_CONTROLLER_AUDIT_MODEL).");
    }
    const apiUrl = resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_CHAT_COMPLETIONS_URL",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_CHAT_COMPLETIONS_URL",
        "PI_GOAL_CONTROLLER_AUDIT_CHAT_COMPLETIONS_URL",
        "AGENT_GOAL_CONTROLLER_AUDIT_API_URL",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_API_URL",
        "PI_GOAL_CONTROLLER_AUDIT_API_URL",
    ]);
    if (!apiUrl) {
        throw new Error("Missing required controller-audit API endpoint: set AGENT_GOAL_CONTROLLER_AUDIT_API_URL (or PI controller audit API URL variants).");
    }
    const apiKey = resolveEnv([
        "AGENT_GOAL_CONTROLLER_AUDIT_API_KEY",
        "AGENT_GOAL_PI_CONTROLLER_AUDIT_API_KEY",
        "PI_GOAL_CONTROLLER_AUDIT_API_KEY",
        "OPENAI_API_KEY",
    ]);
    if (!apiKey) {
        throw new Error("Missing controller-audit API key. Set AGENT_GOAL_CONTROLLER_AUDIT_API_KEY (or OPENAI_API_KEY fallback).");
    }
    return {
        model: model.value,
        apiUrl: normalizeChatCompletionsEndpoint(apiUrl.value),
        apiKey: apiKey.value,
    };
}
function chatCompletionPrompt(snapshot) {
    return renderControllerAuditPrompt(snapshot);
}
function extractCompletionText(payload) {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        const details = payload.error ? ` error=${truncate(JSON.stringify(payload.error), 200)}` : "";
        throw new Error(`Controller audit API response has no completion choices.${details}`);
    }
    const first = choices[0];
    if (!first)
        throw new Error("Controller audit API response has an empty first choice.");
    if (typeof first.message?.content === "string") {
        return first.message.content;
    }
    if (typeof first.text === "string") {
        return first.text;
    }
    const unknown = { message: first.message?.content, text: first.text };
    throw new Error(`Controller audit API response missing completion content: ${truncate(JSON.stringify(unknown), 220)}`);
}
function buildRequestBody(options, model, prompt) {
    const body = {
        model,
        messages: [{ role: "system", content: prompt }],
        temperature: 0,
    };
    if (typeof options.maxTokensPerAudit === "number") {
        body.max_tokens = options.maxTokensPerAudit;
    }
    return JSON.stringify(body);
}
export function createAuditModel() {
    return async (snapshot) => {
        const options = controllerAuditOptions();
        if (!options.enabled) {
            throw new Error("Controller audit is disabled. Set AGENT_GOAL_CONTROLLER_AUDIT=on to enable it.");
        }
        const config = resolveChatCompletionConfig();
        const prompt = chatCompletionPrompt(snapshot);
        const responseBody = buildRequestBody(options, config.model, prompt);
        let response;
        try {
            response = await fetch(config.apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: responseBody,
            });
        }
        catch (error) {
            throw new Error(`Controller audit API request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const responseText = await response.text();
        if (!response.ok) {
            const preview = responseText ? `: ${truncate(responseText, 300)}` : "";
            throw new Error(`Controller audit API request failed (${response.status} ${response.statusText})${preview}`);
        }
        let parsed;
        try {
            parsed = responseText ? JSON.parse(responseText) : {};
        }
        catch (error) {
            throw new Error(`Controller audit API response is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Body: ${truncate(responseText, 300)}`);
        }
        try {
            return extractCompletionText(parsed);
        }
        catch (error) {
            if (error instanceof Error) {
                const details = responseText ? ` Raw response: ${truncate(responseText, 300)}` : "";
                throw new Error(`${error.message}${details}`);
            }
            throw new Error("Controller audit API returned an unparseable completion payload.");
        }
    };
}
//# sourceMappingURL=controller-audit-model.js.map