const KNOWN_PI_MODEL_PROVIDERS = new Set([
    "anthropic",
    "azure-openai",
    "azure-openai-responses",
    "bedrock",
    "cohere",
    "deepseek",
    "gemini",
    "google",
    "groq",
    "local-aeon",
    "minimax",
    "mistral",
    "ollama",
    "openai",
    "openai-codex",
    "openrouter",
    "vertex",
    "xai",
]);
const PI_THINKING_SUFFIX_PATTERN = /:(off|minimal|low|medium|high|xhigh)$/;
/**
 * Pi already accepts goal-runner's canonical `provider/model` model id.
 * This adapter keeps slash-form unchanged and only normalizes legacy
 * dotted provider prefixes seen in older persisted/routing data.
 */
export function normalizePiModelArg(modelArg) {
    const trimmed = modelArg?.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.includes("/"))
        return trimmed;
    const thinkingMatch = PI_THINKING_SUFFIX_PATTERN.exec(trimmed);
    const suffix = thinkingMatch?.[0] ?? "";
    const base = suffix ? trimmed.slice(0, -suffix.length) : trimmed;
    const dot = base.indexOf(".");
    if (dot <= 0 || dot === base.length - 1)
        return trimmed;
    const provider = base.slice(0, dot);
    const model = base.slice(dot + 1);
    if (!isLikelyPiProviderPrefix(provider))
        return trimmed;
    return `${provider}/${model}${suffix}`;
}
function isLikelyPiProviderPrefix(provider) {
    if (KNOWN_PI_MODEL_PROVIDERS.has(provider))
        return true;
    return /^[a-z][a-z0-9-]*$/.test(provider) && provider.includes("-") && !/\d$/.test(provider);
}
//# sourceMappingURL=model-args.js.map