const SYNCABLE_SUBAGENT_STATUSES = new Set(["sessionStarted", "running", "idle"]);
const NON_TERMINAL_SUBAGENT_STATUSES = new Set([
    "planned",
    "workspaceCreated",
    "sessionStarted",
    "running",
    "idle",
    "selfReportedComplete",
    "controllerValidating",
    "needsFollowup",
]);
const MAX_AUTO_RETRIES_DEFAULT = 2;
const TRANSIENT_ERROR_PATTERNS = [
    /server_error/i,
    /timeout/i,
    /rate.?limit/i,
    /too many requests/i,
    /service unavailable/i,
    /temporarily unavailable/i,
    /internal server error/i,
    /bad gateway/i,
    /gateway timeout/i,
    /connection reset/i,
    /econnrefused/i,
    /econnreset/i,
    /etimedout/i,
    /enotfound/i,
    /eai_again/i,
    /network error/i,
    /websocket/i,
    /An error occurred while processing your request/i,
];
const CONTEXT_EXCEEDED_PATTERNS = [
    /context_length_exceeded/i,
    /context window/i,
    /input exceeds/i,
    /too many tokens/i,
    /maximum context length/i,
    /reduce the length/i,
];
const CONTEXT_FALLBACK_MODELS = {
    "openai-codex/gpt-5.3-codex-spark": "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-pro",
    "minimax/MiniMax-M3": "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro", // already largest, no fallback
    "openai-codex/gpt-5.5": "deepseek/deepseek-v4-pro",
};
function isTransientError(message) {
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function isContextExceededError(message) {
    return CONTEXT_EXCEEDED_PATTERNS.some((pattern) => pattern.test(message));
}
function contextFallbackModel(currentModel) {
    if (!currentModel)
        return undefined;
    const fallback = CONTEXT_FALLBACK_MODELS[currentModel];
    // Don't fallback if already on the largest model
    if (fallback === currentModel)
        return undefined;
    return fallback;
}
function buildRecoveryPrompt(node, errorMessage, retryCount, maxRetries) {
    return [
        `[SYSTEM RECOVERY] Your previous attempt encountered a transient error after ${retryCount} retry(s):`,
        `Error: ${errorMessage}`,
        `This is likely a temporary server or network issue.`,
        `Please resume your work on: "${node.objective}"`,
        `Report with SUBAGENT_RESULT: <summary> when done, or SUBAGENT_BLOCKED: <reason> if blocked.`,
        `Retry ${retryCount + 1}/${maxRetries}.`,
    ].join("\n");
}
function buildContextUpgradePrompt(node, oldModel, newModel) {
    return [
        `[SYSTEM RECOVERY] The previous model (${oldModel}) ran out of context window.`,
        `You have been restarted with a larger-context model: ${newModel}.`,
        `Please resume your work on: "${node.objective}"`,
        `Report with SUBAGENT_RESULT: <summary> when done, or SUBAGENT_BLOCKED: <reason> if blocked.`,
    ].join("\n");
}
const OUTCOME_MARKER_FOLLOWUP_TAG = "[SYSTEM FOLLOW-UP: EXPLICIT_OUTCOME_MARKER]";
function buildSubagentFollowupPrompt(node, subagent) {
    return isStaleSubagentSession(subagent)
        ? buildStaleSubagentContinuationPrompt(node, subagent)
        : buildExplicitOutcomeMarkerPrompt(node, subagent);
}
function buildExplicitOutcomeMarkerPrompt(node, subagent) {
    const previous = subagent.selfReportedResult ? `\n\nPrevious assistant outcome text (untrusted transcript evidence):\n${truncateForPrompt(subagent.selfReportedResult, 4000)}` : "";
    return [
        OUTCOME_MARKER_FOLLOWUP_TAG,
        `Your latest assistant message for node "${node.nodeId}" looked like an outcome report but did not include the required marker.`,
        `Do not redo completed work unless you discover it is necessary. Inspect current workspace state only if needed to make an accurate report.`,
        `If the node is done, reply with exactly this marker on its own line followed by a concise summary:`,
        `SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If the node is blocked, reply with exactly this marker instead:`,
        `SUBAGENT_BLOCKED: <specific blocker and what input/state change is needed>`,
        previous,
    ].join("\n");
}
function isStaleSubagentSession(subagent) {
    return /^stale-subagent-session:/i.test(subagent.integrationStatus ?? "");
}
function buildStaleSubagentContinuationPrompt(node, subagent) {
    return [
        `[SYSTEM FOLLOW-UP: STALE_SUBAGENT_SESSION]`,
        `Your previous background Pi session appears to have stopped or gone stale before reporting an outcome for node "${node.nodeId}".`,
        `Observed condition: ${subagent.integrationStatus ?? "stale session"}`,
        `Continue from the existing session transcript and current workspace state. Do not assume unfinished tool calls completed beyond their recorded tool results.`,
        `First inspect current state only as needed (for example git status/diff and relevant files), then continue the node objective: "${node.objective}"`,
        `When done, report exactly this marker on its own line followed by a concise summary:`,
        `SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If blocked, report exactly this marker instead:`,
        `SUBAGENT_BLOCKED: <specific blocker and what input/state change is needed>`,
    ].join("\n");
}
function truncateForPrompt(value, maxChars) {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}
async function tryAutoRecoverFailedNode(runtime, adapter, node, subagent, state, result, options, tickStartedAt) {
    const errorMessage = subagent.integrationStatus ?? subagent.selfReportedResult ?? "unknown error";
    const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    const retryCount = subagent.retryCount ?? 0;
    if (!isTransientError(errorMessage) && !isContextExceededError(errorMessage))
        return false;
    if (retryCount >= maxRetries && !isContextExceededError(errorMessage))
        return false;
    const isContext = isContextExceededError(errorMessage);
    const oldModel = node.modelArg ?? subagent.workspacePath ?? "unknown";
    if (isContext) {
        const fallback = contextFallbackModel(node.modelArg);
        if (!fallback)
            return false; // No larger model available, let it fail permanently
        await runtime.saveGoalDagNode(withNodePatch(node, {
            status: "running",
            modelArg: fallback,
            thinkingLevel: "high",
            lastValidationSummary: `auto-escalated from ${node.modelArg ?? "unknown"} to ${fallback} (context exceeded)`,
            updatedAt: tickStartedAt,
        }));
        node = { ...node, modelArg: fallback, thinkingLevel: "high" };
        const recoveryPrompt = buildContextUpgradePrompt(node, oldModel, fallback);
        const allocation = await options.workspaceAllocator?.({ goalId: subagent.goalId, node, state, adapterId: adapter.adapterId, tickStartedAt });
        const startOptions = {
            subagentId: allocation?.subagentId,
            cwd: allocation?.cwd ?? subagent.workspacePath,
            branch: allocation?.branch ?? subagent.branch,
            ref: allocation?.ref ?? subagent.ref,
            initialPrompt: recoveryPrompt,
            metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}) },
            now: tickStartedAt,
            thinkingLevel: "high",
        };
        await runtime.saveGoalSubagent(withSubagentPatch(subagent, {
            status: "failed",
            integrationStatus: `context exceeded with ${oldModel}; auto-escalated to ${fallback}`,
            retryCount: (subagent.retryCount ?? 0) + 1,
        }));
        const newSubagent = await runtime.startGoalSubagent(adapter, node, startOptions);
        result.started.push(newSubagent);
        return true;
    }
    // Transient error retry
    const recoveryPrompt = buildRecoveryPrompt(node, errorMessage, retryCount, maxRetries);
    const allocation = await options.workspaceAllocator?.({ goalId: subagent.goalId, node, state, adapterId: adapter.adapterId, tickStartedAt });
    const startOptions = {
        subagentId: allocation?.subagentId,
        cwd: allocation?.cwd ?? subagent.workspacePath,
        branch: allocation?.branch ?? subagent.branch,
        ref: allocation?.ref ?? subagent.ref,
        initialPrompt: recoveryPrompt,
        metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}) },
        now: tickStartedAt,
        thinkingLevel: node.thinkingLevel,
    };
    await runtime.saveGoalSubagent(withSubagentPatch(subagent, {
        status: "failed",
        integrationStatus: `auto-retry ${retryCount + 1}/${maxRetries}: ${errorMessage}`,
        retryCount: retryCount + 1,
    }));
    await runtime.saveGoalDagNode(withNodePatch(node, { status: "running", updatedAt: tickStartedAt }));
    const newSubagent = await runtime.startGoalSubagent(adapter, node, startOptions);
    result.started.push(newSubagent);
    return true;
}
export async function runGoalControllerTick(runtime, goalId, options) {
    const tickStartedAt = toIso(resolveNow(options.now));
    const result = {
        goalId,
        started: [],
        synced: [],
        validating: [],
        completed: [],
        followups: [],
        blocked: [],
        failed: [],
        ready: [],
        queueBlocked: [],
        changed: false,
    };
    const initialState = await runtime.getGoalOrchestrationState(goalId);
    await syncSubagents(runtime, options.adapter, initialState, result, options, tickStartedAt);
    await reconcileSubagentOutcomes(runtime, goalId, options, result, tickStartedAt);
    await startReadyNodes(runtime, goalId, options, result, tickStartedAt);
    result.changed =
        result.started.length > 0 ||
            result.synced.length > 0 ||
            result.validating.length > 0 ||
            result.completed.length > 0 ||
            result.followups.length > 0 ||
            result.blocked.length > 0 ||
            result.failed.length > 0;
    return result;
}
export async function runGoalControllerLoop(runtime, goalId, options) {
    const maxTicks = options.maxTicks ?? 1;
    const intervalMs = options.intervalMs ?? 1_000;
    const stopWhenIdle = options.stopWhenIdle ?? true;
    const ticks = [];
    for (let index = 0; index < maxTicks; index += 1) {
        if (options.signal?.aborted)
            break;
        const tick = await runGoalControllerTick(runtime, goalId, options);
        ticks.push(tick);
        if (stopWhenIdle && !tick.changed && tick.ready.length === 0)
            break;
        if (index < maxTicks - 1)
            await sleep(intervalMs, options.signal);
    }
    return { goalId, ticks };
}
async function syncSubagents(runtime, adapter, state, result, options, tickStartedAt) {
    for (const subagent of state.subagents) {
        if (subagent.harnessAdapterId !== adapter.adapterId)
            continue;
        if (!SYNCABLE_SUBAGENT_STATUSES.has(subagent.status))
            continue;
        try {
            const updated = await runtime.syncGoalSubagent(adapter, subagent);
            if (subagentChanged(subagent, updated))
                result.synced.push(updated);
        }
        catch (error) {
            if (isTransientStoreLockError(error))
                continue;
            const errorMessage = error instanceof Error ? error.message : String(error);
            const node = state.nodes.find((item) => item.nodeId === subagent.nodeId);
            if (node) {
                try {
                    const recovered = await tryAutoRecoverFailedNode(runtime, adapter, node, subagent, state, result, options, tickStartedAt);
                    if (recovered)
                        continue;
                }
                catch (_retryError) { /* fall through */ }
            }
            const failed = withSubagentPatch(subagent, {
                status: "failed",
                integrationStatus: errorMessage,
                retryCount: subagent.retryCount,
            });
            await runtime.saveGoalSubagent(failed);
            const failedNode = withNodePatch(node ?? { nodeId: subagent.nodeId }, { status: "failed", lastValidationSummary: failed.integrationStatus });
            await runtime.saveGoalDagNode(failedNode);
            result.failed.push(failedNode);
            result.synced.push(failed);
        }
    }
}
async function reconcileSubagentOutcomes(runtime, goalId, options, result, tickStartedAt) {
    const state = await runtime.getGoalOrchestrationState(goalId);
    const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node]));
    for (const subagent of latestSubagentPerNode(state.subagents)) {
        const node = nodesById.get(subagent.nodeId);
        if (!node)
            continue;
        if (subagent.status === "blocked") {
            const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: subagent.selfReportedResult ?? subagent.integrationStatus });
            await runtime.saveGoalDagNode(blockedNode);
            result.blocked.push(blockedNode);
            continue;
        }
        if (subagent.status === "failed") {
            const state = await runtime.getGoalOrchestrationState(goalId);
            try {
                const recovered = await tryAutoRecoverFailedNode(runtime, options.adapter, node, subagent, state, result, options, tickStartedAt);
                if (recovered)
                    continue;
            }
            catch (_retryError) { /* fall through */ }
            const failedNode = withNodePatch(node, { status: "failed", lastValidationSummary: subagent.integrationStatus ?? subagent.selfReportedResult });
            await runtime.saveGoalDagNode(failedNode);
            result.failed.push(failedNode);
            continue;
        }
        if (subagent.status === "needsFollowup") {
            const followupPrompt = buildSubagentFollowupPrompt(node, subagent);
            const followed = await runtime.sendGoalSubagentPrompt(options.adapter, subagent, followupPrompt, {
                metadata: options.metadata,
                now: tickStartedAt,
            });
            const runningSubagent = withSubagentPatch(followed, { status: "running", integrationStatus: undefined });
            const runningNode = withNodePatch(node, { status: "running", lastValidationSummary: "Requested explicit SUBAGENT_RESULT/SUBAGENT_BLOCKED marker from subagent." });
            await runtime.saveGoalSubagent(runningSubagent);
            await runtime.saveGoalDagNode(runningNode);
            result.followups.push(runningSubagent);
            continue;
        }
        if (subagent.status === "selfReportedComplete" || (subagent.status === "complete" && node.status !== "complete")) {
            await validateOrHold(runtime, options, state, node, subagent, result, tickStartedAt);
            continue;
        }
        if (["sessionStarted", "running", "idle"].includes(subagent.status) && node.status !== "running") {
            await runtime.saveGoalDagNode(withNodePatch(node, { status: "running" }));
        }
    }
}
async function validateOrHold(runtime, options, state, node, subagent, result, tickStartedAt) {
    const validatingNode = withNodePatch(node, { status: "controllerValidating" });
    const validatingSubagent = withSubagentPatch(subagent, { status: "controllerValidating" });
    await runtime.saveGoalDagNode(validatingNode);
    await runtime.saveGoalSubagent(validatingSubagent);
    result.validating.push(validatingNode);
    if (!options.validator)
        return;
    const validation = await options.validator({ goalId: node.goalId, node: validatingNode, subagent: validatingSubagent, state, tickStartedAt });
    const validationSummary = validation.summary ?? validation.validationSignals?.join("; ");
    const validationResults = appendValidationResults(validatingSubagent, validation);
    if (validation.status === "passed") {
        const completedNode = withNodePatch(validatingNode, { status: "complete", lastValidationSummary: validationSummary });
        const completedSubagent = withSubagentPatch(validationResults, { status: "complete" });
        await runtime.saveGoalDagNode(completedNode);
        await runtime.saveGoalSubagent(completedSubagent);
        result.completed.push(completedNode);
        return;
    }
    if (validation.status === "blocked") {
        const blockedNode = withNodePatch(validatingNode, { status: "blocked", lastValidationSummary: validationSummary });
        const blockedSubagent = withSubagentPatch(validationResults, { status: "blocked" });
        await runtime.saveGoalDagNode(blockedNode);
        await runtime.saveGoalSubagent(blockedSubagent);
        result.blocked.push(blockedNode);
        return;
    }
    if (validation.followupPrompt) {
        const followed = await runtime.sendGoalSubagentPrompt(options.adapter, validationResults, validation.followupPrompt, {
            metadata: options.metadata,
            now: tickStartedAt,
        });
        const runningSubagent = withSubagentPatch(followed, { status: "running" });
        const runningNode = withNodePatch(validatingNode, { status: "running", lastValidationSummary: validationSummary });
        await runtime.saveGoalSubagent(runningSubagent);
        await runtime.saveGoalDagNode(runningNode);
        result.followups.push(runningSubagent);
        return;
    }
    const needsFollowupNode = withNodePatch(validatingNode, { status: "needsFollowup", lastValidationSummary: validationSummary });
    const needsFollowupSubagent = withSubagentPatch(validationResults, { status: "needsFollowup" });
    await runtime.saveGoalDagNode(needsFollowupNode);
    await runtime.saveGoalSubagent(needsFollowupSubagent);
    result.followups.push(needsFollowupSubagent);
}
async function startReadyNodes(runtime, goalId, options, result, tickStartedAt) {
    const state = await runtime.getGoalOrchestrationState(goalId);
    const queue = await runtime.getGoalDagReadyQueue(goalId, options.schedulingPolicy);
    result.ready = queue.ready;
    result.queueBlocked = queue.blocked;
    const maxStarts = options.maxStartsPerTick ?? queue.ready.length;
    let started = 0;
    for (const node of queue.ready) {
        if (started >= maxStarts)
            break;
        if (hasNonTerminalSubagentForNode(state.subagents, node.nodeId))
            continue;
        const allocation = await options.workspaceAllocator?.({ goalId, node, state, adapterId: options.adapter.adapterId, tickStartedAt });
        const startOptions = {
            subagentId: allocation?.subagentId,
            cwd: allocation?.cwd,
            branch: allocation?.branch,
            ref: allocation?.ref,
            systemPrompt: allocation?.systemPrompt ?? options.systemPrompt,
            initialPrompt: allocation?.initialPrompt ?? options.renderInitialPrompt?.({ goalId, node, state }) ?? renderDefaultInitialPrompt(node),
            metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}) },
            now: tickStartedAt,
            thinkingLevel: node.thinkingLevel,
        };
        const subagent = await runtime.startGoalSubagent(options.adapter, node, startOptions);
        result.started.push(subagent);
        started += 1;
    }
}
function latestSubagentPerNode(subagents) {
    const latest = new Map();
    for (const subagent of subagents) {
        const current = latest.get(subagent.nodeId);
        if (!current || subagent.updatedAt > current.updatedAt)
            latest.set(subagent.nodeId, subagent);
    }
    return [...latest.values()];
}
function hasNonTerminalSubagentForNode(subagents, nodeId) {
    return subagents.some((subagent) => subagent.nodeId === nodeId && NON_TERMINAL_SUBAGENT_STATUSES.has(subagent.status));
}
function isTransientStoreLockError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
}
function appendValidationResults(subagent, validation) {
    const additions = [validation.summary, ...(validation.validationSignals ?? [])].filter((item) => Boolean(item?.trim()));
    if (additions.length === 0)
        return subagent;
    return { ...subagent, controllerValidationResults: [...(subagent.controllerValidationResults ?? []), ...additions] };
}
function withNodePatch(node, patch) {
    return { ...node, ...patch, updatedAt: new Date().toISOString() };
}
function withSubagentPatch(subagent, patch) {
    return { ...subagent, ...patch, updatedAt: new Date().toISOString(), lastActivityAt: patch.lastActivityAt ?? subagent.lastActivityAt };
}
function subagentChanged(left, right) {
    return JSON.stringify(left) !== JSON.stringify(right);
}
function renderDefaultInitialPrompt(node) {
    return [
        `Implement DAG node ${node.nodeId}: ${node.objective}`,
        node.scope ? `Scope: ${node.scope}` : undefined,
        node.expectedOutputs.length ? `Expected outputs: ${node.expectedOutputs.join(", ")}` : undefined,
        node.validators.length ? `Validators: ${node.validators.join(", ")}` : undefined,
    ].filter((line) => Boolean(line)).join("\n");
}
function resolveNow(now) {
    return typeof now === "function" ? now() : now ?? new Date();
}
function toIso(value) {
    return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
async function sleep(ms, signal) {
    if (ms <= 0)
        return;
    await new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=controller-loop.js.map