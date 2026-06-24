import { normalizeExceptionSignature } from "./exception-handler.js";
import { renderExecutorGuardrailLines } from "./executor-prompt.js";
import { hasSubagentBranchOrWorkspaceEvidence, nodeRequiresSubagentIntegration, requiredSubagentIntegrationTerminalSuccess } from "./integration.js";
import { attachPreparedResourcesToNode, recordAdapterObservationOnNode, recordRecoveryDecisionOnNode, supersedePreparedResourcesOnNode, withGoalDagNodeLifecyclePhase } from "./lifecycle.js";
import { applyAuditActions, buildControllerAuditSnapshot, formatAuditSummary, isAuditDue, recordAuditActionDecisions, validateControllerAuditDecision, } from "./controller-audit.js";
const SYNCABLE_SUBAGENT_STATUSES = new Set(["sessionStarted", "running", "idle", "blocked"]);
// blockedTerminal is intentionally excluded: the subagent session has ended
// and no further transcript updates are expected.
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
const MAX_VALIDATION_FOLLOWUPS_FOR_SAME_FAILURE = 2;
const DEFAULT_STALE_CONTROLLER_STATE_MS = 10 * 60_000;
const DEFAULT_SUBAGENT_PROMPT_DISPATCH_TIMEOUT_MS = 60_000;
const DEFAULT_SUBAGENT_RUNNER_LAUNCH_TIMEOUT_MS = 60_000;
const INTEGRATION_RETRY_COOLDOWN_MS = 60_000;
const RECOVERY_BLOCKED_LEDGER_COOLDOWN_MS = 5 * 60_000;
const recoveryBlockedLedgerCooldown = new Map();
class ControllerActionTimeoutError extends Error {
    actionAttempt;
    actionKind;
    constructor(message, actionAttempt) {
        super(message);
        this.actionAttempt = actionAttempt;
        this.name = "ControllerActionTimeoutError";
        this.actionKind = actionAttempt.actionKind;
    }
}
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
const PROVIDER_LIMIT_ERROR_PATTERNS = [
    /GoUsageLimitError/i,
    /FreeUsageLimitError/i,
    /Monthly usage limit reached/i,
    /available balance/i,
    /insufficient_quota/i,
    /out of budget/i,
    /quota exceeded/i,
    /billing/i,
    /usage limit/i,
    /credit limit/i,
];
const CONTEXT_EXCEEDED_PATTERNS = [
    /context_length_exceeded/i,
    /context window/i,
    /input exceeds/i,
    /too many tokens/i,
    /maximum context length/i,
    /reduce the length/i,
];
const MISSING_SESSION_ERROR_PATTERNS = [
    /session file not found/i,
    /has no sessionFile/i,
    /no sessionFile to resume/i,
    /missing .*session/i,
    /session .*missing/i,
];
const TERMINATED_ERROR_PATTERNS = [
    /^terminated$/i,
    /assistant error:\s*terminated/i,
    /\bterminated\b/i,
];
async function recordControllerEvent(runtime, goalId, event, details = {}, at) {
    if (!runtime.recordControllerEvent)
        return;
    if (shouldSuppressControllerEvent(goalId, event, details, at))
        return;
    try {
        await runtime.recordControllerEvent(goalId, { event, eventKind: event, eventCategory: controllerEventCategory(event), ...details }, { at });
    }
    catch {
        // Controller history is diagnostic only; never let ledger writes disrupt orchestration.
    }
}
function controllerEventCategory(event) {
    if (event.startsWith("poll."))
        return "poll";
    if (event.startsWith("stale") || event.includes(".stale") || event.includes("staleReplay"))
        return "node.staleDetected";
    if (event === "exception.decision" || event === "recovery.decision")
        return "recovery.decision";
    if (event.startsWith("recovery.rule") || event.includes("Rule"))
        return "recovery.rule";
    if (event.startsWith("recovery.") || event.startsWith("followup."))
        return "recovery.action";
    if (event.startsWith("validation."))
        return "validation.result";
    if (event.startsWith("integration."))
        return "integration.result";
    if (event.startsWith("promotion."))
        return "promotion.result";
    if (event.startsWith("cleanup.") || event.includes("Cleanup"))
        return "cleanup.result";
    if (event.startsWith("transcript."))
        return "transcript";
    if (event.startsWith("node.") || event.startsWith("subagent.") || event.startsWith("workspaceAllocation."))
        return "node.lifecycle";
    return "diagnostic";
}
function shouldSuppressControllerEvent(goalId, event, details, at) {
    if (event !== "recovery.blocked" && event !== "staleState.blocked")
        return false;
    const key = [goalId, event, details.nodeId, details.subagentId, details.reason].map((item) => String(item ?? "")).join("\u0000");
    const nowMs = at ? Date.parse(typeof at === "string" ? at : at.toISOString()) : Date.now();
    const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const previous = recoveryBlockedLedgerCooldown.get(key);
    if (previous !== undefined && effectiveNowMs - previous < RECOVERY_BLOCKED_LEDGER_COOLDOWN_MS)
        return true;
    recoveryBlockedLedgerCooldown.set(key, effectiveNowMs);
    if (recoveryBlockedLedgerCooldown.size > 1_000) {
        const cutoff = effectiveNowMs - RECOVERY_BLOCKED_LEDGER_COOLDOWN_MS;
        for (const [candidate, timestamp] of recoveryBlockedLedgerCooldown) {
            if (timestamp < cutoff)
                recoveryBlockedLedgerCooldown.delete(candidate);
        }
    }
    return false;
}
function isTransientError(message) {
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function isContextExceededError(message) {
    return CONTEXT_EXCEEDED_PATTERNS.some((pattern) => pattern.test(message));
}
function isProviderLimitError(message) {
    return PROVIDER_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function isMissingSessionTerminalError(message) {
    return MISSING_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function isTerminatedSessionError(message) {
    return TERMINATED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function buildRecoveryPrompt(node, errorMessage, retryCount, maxRetries) {
    return [
        `[SYSTEM RECOVERY] Your previous assistant turn encountered a recoverable error after ${retryCount} recovery attempt(s):`,
        `Error: ${errorMessage}`,
        `Do not discard prior work. Continue in this same session and preserve the current workspace/context.`,
        `First inspect only what is needed to resume safely (for example git status/diff and the failing command output).`,
        `Then continue your work on: "${node.objective}"`,
        `Report with SUBAGENT_RESULT: <summary> when done, or SUBAGENT_BLOCKED: <reason> if blocked.`,
        `In-place recovery ${retryCount + 1}/${maxRetries}.`,
    ].join("\n");
}
function buildUnhandledScenarioRecoveryPrompt(node, errorMessage, retryCount, maxRetries) {
    return [
        `[SYSTEM RECOVERY: UNHANDLED_SCENARIO] The controller observed an unclassified error but is preserving this session instead of abandoning it.`,
        `Error: ${errorMessage}`,
        `Diagnose the situation from the existing transcript/workspace. If you can remediate, continue the node objective: "${node.objective}"`,
        `If this is a runtime/controller bug or requires developer input, report SUBAGENT_BLOCKED with a concise reproduction and proposed handler.`,
        `Do not start over unless current workspace inspection proves prior work is unusable.`,
        `In-place diagnostic recovery ${retryCount + 1}/${maxRetries}.`,
    ].join("\n");
}
function quotaBlockedSummary(errorMessage) {
    return `blocked: provider/model quota or billing limit reached; configure harness model bindings, credentials, or quota before continuing. Error: ${errorMessage}`;
}
function unhandledScenarioBlockedSummary(errorMessage) {
    return `blocked: unhandled subagent error after in-place recovery attempts; add a controller recovery handler or provide developer guidance. Error: ${errorMessage}`;
}
function buildBlockedNodeRecoveryPrompt(node, blockedReason, retryCount, maxRetries) {
    return [
        `[SYSTEM RECOVERY: BLOCKED_NODE_ACTIVE_GOAL] The parent goal is still active, so the controller is asking you to make one more best-effort attempt to clear this node blocker in the same session.`,
        `Current blocked reason / validation summary: ${truncateForPrompt(blockedReason, 4000)}`,
        `Do not discard prior work. Inspect only what is needed to determine whether the blocker is already fixed or can be fixed safely.`,
        `If the blocker is already resolved or you can resolve it, continue the node objective: "${node.objective}"`,
        `When done, report exactly: SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If the blocker truly requires external input or an unavailable state change, report exactly: SUBAGENT_BLOCKED: <specific blocker and needed input/state change>`,
        `Best-effort blocked-node recovery ${retryCount + 1}/${maxRetries}.`,
    ].join("\n");
}
function buildMissingSessionReplacementPrompt(node, errorMessage, retryCount, maxRetries) {
    return buildReplacementPrompt(node, errorMessage, retryCount, maxRetries, "STALE_MISSING_SESSION_REPLACEMENT", "The previous background subagent runner stopped before a usable session transcript existed.");
}
function buildTerminatedSessionReplacementPrompt(node, errorMessage, retryCount, maxRetries) {
    return buildReplacementPrompt(node, errorMessage, retryCount, maxRetries, "TERMINATED_SESSION_REPLACEMENT", "The previous background subagent session repeatedly terminated after same-session recovery attempts.");
}
function buildReplacementPrompt(node, errorMessage, retryCount, maxRetries, tag, explanation) {
    return [
        `[SYSTEM RECOVERY: ${tag}] ${explanation}`,
        `Observed condition: ${errorMessage}`,
        `This is a replacement attempt ${retryCount + 1}/${maxRetries}; do not rely on the previous transcript as live context.`,
        `First inspect the current workspace state only as needed (for example git status/diff and relevant files).`,
        `Preserve any useful existing workspace changes, but do not assume unrecorded tool calls completed successfully.`,
        `Then continue the DAG node objective: "${node.objective}"`,
        node.scope ? `Scope: ${node.scope}` : undefined,
        node.expectedOutputs.length ? `Expected outputs: ${node.expectedOutputs.join(", ")}` : undefined,
        node.validators.length ? `Validators: ${node.validators.join(", ")}` : undefined,
        `When done, report exactly: SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If blocked, report exactly: SUBAGENT_BLOCKED: <specific blocker and needed input/state change>`,
    ].filter((line) => Boolean(line)).join("\n");
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
async function startReplacementForMissingSession(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage) {
    return startReplacementSubagent(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage, {
        mode: "stale-missing-session",
        prompt: buildMissingSessionReplacementPrompt,
        blockWhenRetryCountAtMax: true,
        terminalSummary: (error) => `stale subagent attempt terminalized: ${error}`,
        replacementSummary: (attempt, maxRetries, previous, error) => `replacement attempt ${attempt}/${maxRetries} for stale missing session ${previous}: ${error}`,
        blockSummary: (retryCount, maxRetries, error) => `blocked: stale subagent session could not be recovered after ${retryCount}/${maxRetries} replacement attempt(s). Error: ${error}`,
    });
}
async function startReplacementForTerminatedSession(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage) {
    return startReplacementSubagent(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage, {
        mode: "terminated-session",
        prompt: buildTerminatedSessionReplacementPrompt,
        blockWhenRetryCountAtMax: false,
        terminalSummary: (error) => `terminated subagent attempt replaced after same-session retries were exhausted: ${error}`,
        replacementSummary: (attempt, maxRetries, previous, error) => `fresh replacement attempt ${attempt}/${maxRetries} after repeated terminated errors in ${previous}: ${error}`,
        blockSummary: (retryCount, maxRetries, error) => `blocked: terminated subagent session could not be recovered after replacement attempt ${retryCount}/${maxRetries}. Error: ${error}`,
    });
}
async function startReplacementSubagent(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage, behavior) {
    const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    const maxReplacementAttempts = behavior.blockWhenRetryCountAtMax ? maxRetries : maxRetries + 1;
    const retryCount = subagent.retryCount ?? 0;
    const attempt = retryCount + 1;
    if (retryCount >= maxReplacementAttempts) {
        const summary = behavior.blockSummary(retryCount, maxReplacementAttempts, errorMessage);
        const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
        const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            mode: behavior.mode,
            reason: summary,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    const terminalSummary = behavior.terminalSummary(errorMessage);
    const terminalSubagent = withSubagentPatch(subagent, {
        status: "failed",
        integrationStatus: terminalSummary,
        retryCount: attempt,
        updatedAt: tickStartedAt,
    });
    await runtime.saveGoalSubagent(terminalSubagent);
    await recordControllerEvent(runtime, subagent.goalId, "recovery.staleSessionTerminalized", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        mode: behavior.mode,
        retry: attempt,
        maxRetries: maxReplacementAttempts,
        reason: errorMessage,
    }, tickStartedAt);
    result.synced.push(terminalSubagent);
    const replacementPrompt = behavior.prompt(node, errorMessage, retryCount, maxReplacementAttempts);
    const replacementSubagentId = uniqueReplacementSubagentId(state.subagents, subagent.subagentId, attempt);
    const reusableResources = recoveryPreparedResources(node, subagent, tickStartedAt, {
        subagentId: replacementSubagentId,
        clearSession: true,
        metadata: {
            staleReplacementFor: subagent.subagentId,
            staleReplacementMode: behavior.mode,
            staleReplacementReason: errorMessage,
            staleReplacementAttempt: attempt,
        },
    });
    const allocation = hasConcretePreparedResource(reusableResources)
        ? undefined
        : await options.workspaceAllocator?.({ goalId: subagent.goalId, node, state, adapterId: adapter.adapterId, tickStartedAt });
    const allocatedSubagentId = allocation?.subagentId && allocation.subagentId !== subagent.subagentId ? allocation.subagentId : undefined;
    const effectiveSubagentId = allocatedSubagentId ?? replacementSubagentId;
    const preparedResources = {
        ...reusableResources,
        subagentId: effectiveSubagentId,
        adapterId: adapter.adapterId,
        workspacePath: reusableResources.workspacePath ?? allocation?.cwd,
        branch: reusableResources.branch ?? allocation?.branch,
        ref: reusableResources.ref ?? allocation?.ref,
        modelArg: metadataString(allocation?.metadata, "modelArg") ?? reusableResources.modelArg,
        modelScenario: metadataString(allocation?.metadata, "modelScenario") ?? reusableResources.modelScenario,
        modelClass: metadataString(allocation?.metadata, "modelClass") ?? reusableResources.modelClass,
        modelResolution: metadataModelResolution(allocation?.metadata) ?? reusableResources.modelResolution,
        thinkingLevel: metadataString(allocation?.metadata, "thinkingLevel") ?? reusableResources.thinkingLevel ?? node.thinkingLevel,
        metadata: { ...(reusableResources.metadata ?? {}), ...(allocation?.metadata ?? {}) },
        updatedAt: tickStartedAt,
    };
    const startOptions = {
        subagentId: effectiveSubagentId,
        cwd: preparedResources.workspacePath,
        branch: preparedResources.branch,
        ref: preparedResources.ref,
        systemPrompt: allocation?.systemPrompt ?? options.systemPrompt,
        initialPrompt: replacementPrompt,
        preparedResources,
        metadata: { ...(options.metadata ?? {}), ...(preparedResources.metadata ?? {}) },
        now: tickStartedAt,
        thinkingLevel: preparedResources.thinkingLevel ?? node.thinkingLevel,
    };
    const started = await startGoalSubagentWithTimeout(runtime, options, adapter, node, startOptions, tickStartedAt);
    const replacement = withSubagentPatch(started, {
        retryCount: attempt,
        integrationStatus: behavior.replacementSummary(attempt, maxReplacementAttempts, subagent.subagentId, errorMessage),
        lastActivityAt: tickStartedAt,
        updatedAt: tickStartedAt,
    });
    await runtime.saveGoalSubagent(replacement);
    await runtime.saveGoalDagNode(withNodePatch(attachPreparedResourcesToNode(node, {
        ...preparedResources,
        subagentId: replacement.subagentId,
        sessionId: replacement.sessionId,
        sessionFile: replacement.sessionFile,
        workspacePath: replacement.workspacePath ?? preparedResources.workspacePath,
        branch: replacement.branch ?? preparedResources.branch,
        ref: replacement.ref ?? preparedResources.ref,
    }, { phase: "runnerActive", now: tickStartedAt }), {
        status: "running",
        lifecyclePhase: "runnerActive",
        lastValidationSummary: `replacement subagent ${replacement.subagentId} started after ${behavior.mode} ${subagent.subagentId}`,
        updatedAt: tickStartedAt,
    }));
    await recordControllerEvent(runtime, subagent.goalId, "recovery.replacedStaleSession", {
        nodeId: node.nodeId,
        previousSubagentId: subagent.subagentId,
        subagentId: replacement.subagentId,
        mode: behavior.mode,
        retry: attempt,
        maxRetries: maxReplacementAttempts,
        workspacePath: replacement.workspacePath,
        branch: replacement.branch,
        reason: errorMessage,
    }, tickStartedAt);
    result.started.push(replacement);
    return true;
}
function uniqueReplacementSubagentId(subagents, baseSubagentId, attempt) {
    const existing = new Set(subagents.map((item) => item.subagentId));
    const base = `${baseSubagentId}-retry-${attempt}`;
    if (!existing.has(base))
        return base;
    for (let index = 2; index < 100; index += 1) {
        const candidate = `${base}-${index}`;
        if (!existing.has(candidate))
            return candidate;
    }
    return `${base}-${Date.now()}`;
}
async function tryAutoRecoverFailedNode(runtime, adapter, node, subagent, state, result, options, tickStartedAt, observedError) {
    const errorMessage = observedError ?? subagent.integrationStatus ?? subagent.selfReportedResult ?? "unknown error";
    const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    const retryCount = subagent.retryCount ?? 0;
    if (isMissingSessionTerminalError(errorMessage)) {
        return startReplacementForMissingSession(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage);
    }
    if (isTerminatedSessionError(errorMessage) && retryCount >= maxRetries) {
        return startReplacementForTerminatedSession(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage);
    }
    if (isProviderLimitError(errorMessage)) {
        const summary = quotaBlockedSummary(errorMessage);
        const blockedSubagent = withSubagentPatch(subagent, {
            status: "blocked",
            integrationStatus: summary,
            retryCount,
            updatedAt: tickStartedAt,
        });
        const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            reason: summary,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    const isContext = isContextExceededError(errorMessage);
    const oldModel = node.modelArg ?? subagent.workspacePath ?? "unknown";
    if (isContext) {
        const summary = `Model resolution blocked automatic context fallback after ${oldModel}: ${errorMessage}`;
        const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
        const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            reason: summary,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    const isTransient = isTransientError(errorMessage);
    if (retryCount >= maxRetries) {
        const summary = unhandledScenarioBlockedSummary(errorMessage);
        const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
        const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            reason: summary,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    const recoveryPrompt = isTransient
        ? buildRecoveryPrompt(node, errorMessage, retryCount, maxRetries)
        : buildUnhandledScenarioRecoveryPrompt(node, errorMessage, retryCount, maxRetries);
    const status = isTransient
        ? `in-place recovery ${retryCount + 1}/${maxRetries}: ${errorMessage}`
        : `unhandled-scenario recovery ${retryCount + 1}/${maxRetries}: ${errorMessage}`;
    let recovered;
    try {
        recovered = await sendGoalSubagentPromptWithTimeout(runtime, options, adapter, subagent, recoveryPrompt, tickStartedAt);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isProviderLimitError(errorMessage)) {
            const summary = quotaBlockedSummary(errorMessage);
            const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
            const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
            await runtime.saveGoalSubagent(blockedSubagent);
            await runtime.saveGoalDagNode(blockedNode);
            await recordControllerEvent(runtime, subagent.goalId, "recovery.blocked", {
                nodeId: node.nodeId,
                subagentId: subagent.subagentId,
                reason: summary,
            }, tickStartedAt);
            result.blocked.push(blockedNode);
            result.synced.push(blockedSubagent);
            return true;
        }
        await degradePromptDispatchFailure(runtime, node, subagent, result, tickStartedAt, `${status}; recovery prompt dispatch failed: ${errorMessage}`, error);
        return true;
    }
    const runningSubagent = withSubagentPatch(recovered, {
        status: "running",
        integrationStatus: status,
        retryCount: retryCount + 1,
        updatedAt: tickStartedAt,
        lastActivityAt: tickStartedAt,
    });
    const runningNode = withNodePatch(node, { status: "running", lastValidationSummary: status, updatedAt: tickStartedAt });
    await runtime.saveGoalSubagent(runningSubagent);
    await runtime.saveGoalDagNode(runningNode);
    await recordControllerEvent(runtime, subagent.goalId, "recovery.sent", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        mode: isTransient ? "transient" : "unhandled-scenario",
        retry: retryCount + 1,
        maxRetries,
        reason: errorMessage,
    }, tickStartedAt);
    result.followups.push(runningSubagent);
    result.synced.push(runningSubagent);
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
    await recordControllerEvent(runtime, goalId, "poll.started", {
        nodes: initialState.nodes.length,
        subagents: initialState.subagents.length,
    }, tickStartedAt);
    await syncSubagents(runtime, options.adapter, initialState, result, options, tickStartedAt);
    await reconcileSubagentOutcomes(runtime, goalId, options, result, tickStartedAt);
    await reconcileStaleControllerStates(runtime, goalId, options, result, tickStartedAt);
    await reconcileStaleRunnerStartingNodes(runtime, goalId, options, result, tickStartedAt);
    await startReadyNodes(runtime, goalId, options, result, tickStartedAt);
    result.changed =
        result.started.length > 0 ||
            result.synced.length > 0 ||
            result.validating.length > 0 ||
            result.completed.length > 0 ||
            result.followups.length > 0 ||
            result.blocked.length > 0 ||
            result.failed.length > 0;
    await recordControllerEvent(runtime, goalId, "poll.finished", {
        changed: result.changed,
        started: result.started.length,
        synced: result.synced.length,
        validating: result.validating.length,
        completed: result.completed.length,
        followups: result.followups.length,
        blocked: result.blocked.length,
        failed: result.failed.length,
        ready: result.ready.length,
        queueBlocked: result.queueBlocked.length,
    }, tickStartedAt);
    await runControllerAuditGate(runtime, goalId, options, result, tickStartedAt);
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
        // Additional fast-path: exit when all nodes are terminal (complete/failed/blockedTerminal)
        // even if ready queue has stale references.
        if (stopWhenIdle && !tick.changed) {
            const state = await runtime.getGoalOrchestrationState(goalId);
            const TERMINAL_STATUSES = new Set(["complete", "failed", "blockedTerminal"]);
            const allTerminal = state.nodes.length > 0 && state.nodes.every((n) => TERMINAL_STATUSES.has(n.status));
            if (allTerminal)
                break;
        }
        if (index < maxTicks - 1)
            await sleep(intervalMs, options.signal);
    }
    return { goalId, ticks };
}
// ---------------------------------------------------------------------------
// Controller audit gate
// ---------------------------------------------------------------------------
/**
 * Runs the periodic controller audit gate at the end of a tick.
 *
 * When {@link GoalControllerTickOptions.audit} is enabled and the configured
 * interval has elapsed, this function:
 *
 * 1. Builds a structured {@link GoalControllerAuditSnapshot}
 * 2. Passes the snapshot to the configured audit model
 * 3. Validates the returned decision against the schema
 * 4. Applies safe actions (currently only `pause-goal` on critical risk)
 * 5. Records lifecycle events in the controller ledger
 * 6. Sets audit-related fields on the tick result
 *
 * The function is resilient: missing optional port methods, audit model
 * failures, or invalid model output are all handled gracefully with
 * ledger event recording and no crash.
 */
async function runControllerAuditGate(runtime, goalId, options, result, tickStartedAt) {
    // Quick guard: audit not configured or disabled.
    if (!options.audit?.enabled)
        return;
    if (!options.auditModel)
        return;
    // Require optional port methods for audit data access.
    if (!runtime.getGoalRecord || !runtime.listGoalLedgerEvents)
        return;
    const auditOptions = options.audit;
    let goal;
    let events;
    try {
        goal = await runtime.getGoalRecord(goalId);
        events = await runtime.listGoalLedgerEvents(goalId);
    }
    catch {
        // Data fetch failed — skip audit this tick.
        await recordControllerEvent(runtime, goalId, "controller_audit_started", {
            error: "Failed to fetch goal record or ledger events for audit snapshot.",
        }, tickStartedAt);
        return;
    }
    // Only audit active goals.
    if (goal.status !== "active")
        return;
    // Determine last audit timestamp from ledger events.
    const lastAuditAt = lastAuditAtFromEvents(events);
    if (!isAuditDue(auditOptions, lastAuditAt, new Date(tickStartedAt)))
        return;
    // --- Audit is due: build snapshot and invoke model ---
    await recordControllerEvent(runtime, goalId, "controller_audit_started", {
        lastAuditAt: lastAuditAt ?? null,
        nodes: result.ready.length + result.started.length + result.synced.length,
    }, tickStartedAt);
    // Re-fetch orchestration state for a fresh snapshot.
    let state;
    try {
        state = await runtime.getGoalOrchestrationState(goalId);
    }
    catch {
        await recordControllerEvent(runtime, goalId, "controller_audit_finished", {
            error: "Failed to fetch orchestration state for audit snapshot.",
        }, tickStartedAt);
        return;
    }
    const snapshot = buildControllerAuditSnapshot({
        state,
        goal,
        recentEvents: events,
        options: auditOptions,
        now: new Date(tickStartedAt),
    });
    // --- Invoke audit model ---
    let rawOutput;
    try {
        rawOutput = await options.auditModel(snapshot);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await recordControllerEvent(runtime, goalId, "controller_audit_invalid_output", {
            error: `Audit model invocation failed: ${errorMessage}`,
        }, tickStartedAt);
        await recordControllerEvent(runtime, goalId, "controller_audit_finished", {
            outcome: "model_error",
            error: errorMessage,
        }, tickStartedAt);
        return;
    }
    // --- Parse model output as JSON decision ---
    let candidate;
    try {
        candidate = extractJsonFromModelOutput(rawOutput);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await recordControllerEvent(runtime, goalId, "controller_audit_invalid_output", {
            error: `Failed to parse audit model output as JSON: ${errorMessage}`,
            rawOutput: typeof rawOutput === "string" ? rawOutput.slice(0, 500) : String(rawOutput).slice(0, 500),
        }, tickStartedAt);
        await recordControllerEvent(runtime, goalId, "controller_audit_finished", {
            outcome: "parse_error",
            error: errorMessage,
        }, tickStartedAt);
        return;
    }
    // --- Validate decision against schema ---
    const validation = validateControllerAuditDecision(candidate);
    if (!validation.valid) {
        await recordControllerEvent(runtime, goalId, "controller_audit_invalid_output", {
            errors: validation.errors,
            candidate: safeTruncate(JSON.stringify(candidate), 500),
        }, tickStartedAt);
        await recordControllerEvent(runtime, goalId, "controller_audit_finished", {
            outcome: "invalid_decision",
            errors: validation.errors,
        }, tickStartedAt);
        return;
    }
    const decision = validation.decision;
    // --- Apply safe actions ---
    const policyResult = applyAuditActions(decision, auditOptions);
    // --- Record action events ---
    // --- Record action decisions (applied/skipped) ---
    // These are informational records of what the policy decided, recorded
    // before the actual pause so the ledger preserves the recommendation
    // even if the pause fails.
    const auditEventRecorder = async (eventType, details, at) => {
        await recordControllerEvent(runtime, goalId, eventType, details, at ?? tickStartedAt);
    };
    await recordAuditActionDecisions(policyResult, decision, auditEventRecorder, tickStartedAt);
    // --- Apply auto-pause if indicated ---
    let pauseApplied = false;
    let pauseUnavailable = false;
    let pauseFailed = false;
    if (policyResult.shouldPauseGoal) {
        if (runtime.auditPauseGoal) {
            try {
                await runtime.auditPauseGoal(goalId, policyResult.pauseReason ?? "Controller audit auto-pause");
                // Pause succeeded: record definitive applied and paused events.
                await recordControllerEvent(runtime, goalId, "controller_audit_action_applied", {
                    action: "pause-goal",
                    reason: policyResult.pauseReason,
                    risk: decision.risk,
                    findingKinds: decision.findings.map((finding) => finding.kind),
                }, tickStartedAt);
                await recordControllerEvent(runtime, goalId, "goal_paused_by_controller_audit", {
                    risk: decision.risk,
                    summary: decision.summary,
                    pauseReason: policyResult.pauseReason,
                    findingKinds: decision.findings.map((finding) => finding.kind),
                }, tickStartedAt);
                result.auditPausedGoal = true;
                pauseApplied = true;
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                await recordControllerEvent(runtime, goalId, "controller_audit_action_failed", {
                    action: "pause-goal",
                    error: errorMessage,
                    summary: decision.summary,
                    risk: decision.risk,
                }, tickStartedAt);
                pauseFailed = true;
            }
        }
        else {
            // auditPauseGoal not available: record skipped, do not claim paused.
            await recordControllerEvent(runtime, goalId, "controller_audit_action_skipped", {
                action: "pause-goal",
                reason: "auditPauseGoal port method is not available on this runtime.",
                risk: decision.risk,
            }, tickStartedAt);
            pauseUnavailable = true;
        }
    }
    // --- Record audit finished with accurate outcome ---
    const finishedOutcome = pauseApplied
        ? "paused"
        : pauseFailed
            ? "pause_failed"
            : pauseUnavailable
                ? "pause_unavailable"
                : "completed";
    await recordControllerEvent(runtime, goalId, "controller_audit_finished", {
        outcome: finishedOutcome,
        risk: decision.risk,
        summary: decision.summary,
        findingKinds: decision.findings.map((finding) => finding.kind),
        actionsRecommended: policyResult.applied.map((entry) => entry.action.action),
        actionsApplied: pauseApplied ? ["pause-goal"] : [],
        actionsSkipped: policyResult.skipped.map((entry) => entry.action.action),
    }, tickStartedAt);
    result.auditRun = true;
    result.auditSummary = formatAuditSummary(decision, pauseApplied ? policyResult.applied : []);
}
/**
 * Derives the last audit timestamp from ledger events by scanning for
 * the most recent `controller_audit_finished` event.
 *
 * Controller events are stored with `type: "controller_event"` and the
 * specific event name in `details.event`, so we check both the primary
 * type and the nested event field.
 */
function lastAuditAtFromEvents(events) {
    let latest;
    for (const event of events) {
        const isAuditFinished = event.type === "controller_audit_finished" ||
            (event.type === "controller_event" && event.details?.event === "controller_audit_finished");
        if (isAuditFinished) {
            if (!latest || event.at > latest) {
                latest = event.at;
            }
        }
    }
    return latest;
}
/**
 * Attempts to extract a JSON object from model output that may be
 * wrapped in markdown code fences or prefixed with explanatory text.
 */
function extractJsonFromModelOutput(raw) {
    if (raw === null || raw === undefined) {
        throw new Error("Audit model returned null or undefined");
    }
    if (typeof raw === "object") {
        // Already an object — assume it is the decision directly.
        return raw;
    }
    if (typeof raw !== "string") {
        throw new Error(`Audit model returned non-string, non-object: ${typeof raw}`);
    }
    let text = raw.trim();
    // Try to extract JSON from markdown code fences.
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }
    // If the text starts with a non-`{`/`[` character, try to find the
    // first JSON object/array boundary and take from there.
    if (text.length > 0 && text[0] !== "{" && text[0] !== "[") {
        const objStart = text.indexOf("{");
        const arrStart = text.indexOf("[");
        let start = -1;
        if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
            start = objStart;
        }
        else if (arrStart >= 0) {
            start = arrStart;
        }
        if (start >= 0) {
            text = text.slice(start);
        }
    }
    return JSON.parse(text);
}
function safeTruncate(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return value.slice(0, maxLength) + "…";
}
async function syncSubagents(runtime, adapter, state, result, options, tickStartedAt) {
    for (const subagent of state.subagents) {
        if (subagent.harnessAdapterId !== adapter.adapterId)
            continue;
        if (!SYNCABLE_SUBAGENT_STATUSES.has(subagent.status))
            continue;
        try {
            const updated = await runtime.syncGoalSubagent(adapter, subagent);
            if (subagentChanged(subagent, updated)) {
                result.synced.push(updated);
                const node = state.nodes.find((item) => item.nodeId === updated.nodeId);
                if (node && updated.lastAdapterObservation) {
                    await runtime.saveGoalDagNode(recordAdapterObservationOnNode(node, updated.lastAdapterObservation, {
                        phase: lifecyclePhaseForObservation(updated.lastAdapterObservation),
                        now: tickStartedAt,
                    }));
                }
                await recordControllerEvent(runtime, updated.goalId, controllerEventForSyncedSubagent(updated), {
                    nodeId: updated.nodeId,
                    subagentId: updated.subagentId,
                    from: subagent.status,
                    to: updated.status,
                    observation: updated.lastAdapterObservation?.kind,
                    summary: updated.selfReportedResult ?? updated.integrationStatus,
                }, tickStartedAt);
            }
        }
        catch (error) {
            if (isTransientStoreLockError(error))
                continue;
            const errorMessage = error instanceof Error ? error.message : String(error);
            const node = state.nodes.find((item) => item.nodeId === subagent.nodeId);
            if (node) {
                try {
                    const recovered = await tryAutoRecoverFailedNode(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage);
                    if (recovered)
                        continue;
                }
                catch (retryError) {
                    const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
                    const summary = isProviderLimitError(retryErrorMessage)
                        ? quotaBlockedSummary(retryErrorMessage)
                        : unhandledScenarioBlockedSummary(`${errorMessage}; recovery failed: ${retryErrorMessage}`);
                    const blocked = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, updatedAt: tickStartedAt });
                    const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
                    await runtime.saveGoalSubagent(blocked);
                    await runtime.saveGoalDagNode(blockedNode);
                    result.blocked.push(blockedNode);
                    result.synced.push(blocked);
                    continue;
                }
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
            const integrationRetried = await tryRetryBlockedIntegration(runtime, options, state, node, subagent, result, tickStartedAt);
            if (integrationRetried)
                continue;
            const handled = await tryHandleAbnormalObservation(runtime, options, state, node, subagent, result, tickStartedAt, subagent.lastAdapterObservation ?? observationFromSubagentStatus(options.adapter.adapterId, subagent, "selfReportedBlocked", tickStartedAt));
            if (handled)
                continue;
            const recovered = await tryRecoverBlockedSubagent(runtime, options, state, node, subagent, result, tickStartedAt);
            if (recovered)
                continue;
            const blockedSummary = subagent.integrationStatus ?? subagent.selfReportedResult;
            if (node.status !== "blocked" || node.lastValidationSummary !== blockedSummary) {
                const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: blockedSummary, updatedAt: tickStartedAt });
                await runtime.saveGoalDagNode(blockedNode);
                result.blocked.push(blockedNode);
            }
            continue;
        }
        if (subagent.status === "blockedTerminal") {
            const integrationRetried = await tryRetryBlockedIntegration(runtime, options, state, node, subagent, result, tickStartedAt);
            if (integrationRetried)
                continue;
            continue;
        }
        if (subagent.status === "failed") {
            const state = await runtime.getGoalOrchestrationState(goalId);
            const restartedInterruptedReplacement = await tryRestartInterruptedValidationCappedReplacement(runtime, options, state, node, subagent, result, tickStartedAt);
            if (restartedInterruptedReplacement)
                continue;
            const handled = await tryHandleAbnormalObservation(runtime, options, state, node, subagent, result, tickStartedAt, subagent.lastAdapterObservation ?? observationFromSubagentStatus(options.adapter.adapterId, subagent, "runnerError", tickStartedAt));
            if (handled)
                continue;
            try {
                const recovered = await tryAutoRecoverFailedNode(runtime, options.adapter, node, subagent, state, result, options, tickStartedAt);
                if (recovered)
                    continue;
            }
            catch (retryError) {
                const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
                const originalError = subagent.integrationStatus ?? subagent.selfReportedResult ?? "unknown error";
                const summary = isProviderLimitError(retryErrorMessage)
                    ? quotaBlockedSummary(retryErrorMessage)
                    : unhandledScenarioBlockedSummary(`${originalError}; recovery failed: ${retryErrorMessage}`);
                const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, updatedAt: tickStartedAt });
                const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
                await runtime.saveGoalSubagent(blockedSubagent);
                await runtime.saveGoalDagNode(blockedNode);
                result.blocked.push(blockedNode);
                result.synced.push(blockedSubagent);
                continue;
            }
            const failedNode = withNodePatch(node, { status: "failed", lastValidationSummary: subagent.integrationStatus ?? subagent.selfReportedResult });
            await runtime.saveGoalDagNode(failedNode);
            result.failed.push(failedNode);
            continue;
        }
        if (subagent.status === "needsFollowup") {
            const handled = await tryHandleAbnormalObservation(runtime, options, state, node, subagent, result, tickStartedAt, subagent.lastAdapterObservation ?? observationFromSubagentStatus(options.adapter.adapterId, subagent, "protocolViolation", tickStartedAt));
            if (handled)
                continue;
            const followupPrompt = buildSubagentFollowupPrompt(node, subagent);
            let followed;
            try {
                followed = await sendGoalSubagentPromptWithTimeout(runtime, options, options.adapter, subagent, followupPrompt, tickStartedAt);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                await degradePromptDispatchFailure(runtime, node, subagent, result, tickStartedAt, `explicit outcome-marker follow-up dispatch failed: ${errorMessage}`, error);
                continue;
            }
            const runningSubagent = withSubagentPatch(followed, { status: "running", integrationStatus: undefined });
            const runningNode = withNodePatch(node, { status: "running", lastValidationSummary: "Requested explicit SUBAGENT_RESULT/SUBAGENT_BLOCKED marker from subagent." });
            await runtime.saveGoalSubagent(runningSubagent);
            await runtime.saveGoalDagNode(runningNode);
            result.followups.push(runningSubagent);
            continue;
        }
        if (subagent.status === "selfReportedComplete" || (subagent.status === "complete" && node.status !== "complete")) {
            await validateOrHold(runtime, options, state, withGoalDagNodeLifecyclePhase(node, "controllerJudging", { status: "controllerValidating", now: tickStartedAt }), subagent, result, tickStartedAt);
            continue;
        }
        if (["sessionStarted", "running", "idle"].includes(subagent.status) && node.status !== "running") {
            await runtime.saveGoalDagNode(withNodePatch(node, { status: "running" }));
        }
    }
}
async function reconcileStaleControllerStates(runtime, goalId, options, result, tickStartedAt) {
    const thresholdMs = options.staleStateThresholdMs ?? DEFAULT_STALE_CONTROLLER_STATE_MS;
    if (thresholdMs <= 0)
        return;
    const state = await runtime.getGoalOrchestrationState(goalId);
    const latestSubagents = latestSubagentPerNode(state.subagents);
    for (const subagent of latestSubagents) {
        const node = state.nodes.find((candidate) => candidate.nodeId === subagent.nodeId);
        if (!node)
            continue;
        if (node.status !== "controllerValidating" && subagent.status !== "controllerValidating")
            continue;
        const ageMs = controllerStateAgeMs(node, subagent, tickStartedAt);
        if (ageMs < thresholdMs)
            continue;
        const summary = `stale controller state: node=${node.status}, subagent=${subagent.status} for ${Math.floor(ageMs / 1000)}s (threshold ${Math.floor(thresholdMs / 1000)}s)`;
        await recordControllerEvent(runtime, node.goalId, "staleState.detected", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            nodeStatus: node.status,
            subagentStatus: subagent.status,
            ageMs,
            thresholdMs,
        }, tickStartedAt);
        if (options.validator && subagent.selfReportedResult) {
            await validateOrHold(runtime, options, state, withGoalDagNodeLifecyclePhase(node, "controllerJudging", { status: "controllerValidating", now: tickStartedAt }), subagent, result, tickStartedAt);
            continue;
        }
        const observation = {
            adapterId: options.adapter.adapterId,
            kind: "protocolViolation",
            at: tickStartedAt,
            summary,
            error: summary,
            evidence: {
                staleState: true,
                nodeStatus: node.status,
                subagentStatus: subagent.status,
                ageMs,
                thresholdMs,
                nodeUpdatedAt: node.updatedAt,
                subagentUpdatedAt: subagent.updatedAt,
            },
        };
        const handled = await tryHandleAbnormalObservation(runtime, options, state, node, subagent, result, tickStartedAt, observation);
        if (handled)
            continue;
        const needsFollowupSubagent = withSubagentPatch(subagent, { status: "needsFollowup", integrationStatus: summary, updatedAt: tickStartedAt });
        const needsFollowupNode = withNodePatch(node, { status: "needsFollowup", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(needsFollowupSubagent);
        await runtime.saveGoalDagNode(needsFollowupNode);
        await recordControllerEvent(runtime, node.goalId, "staleState.needsFollowup", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            summary,
        }, tickStartedAt);
        result.followups.push(needsFollowupSubagent);
        result.synced.push(needsFollowupSubagent);
    }
    // ── Stale blocked detection (blocked / blockedTerminal) ──
    for (const subagent of latestSubagents) {
        const node = state.nodes.find((candidate) => candidate.nodeId === subagent.nodeId);
        if (!node)
            continue;
        const blockedStatuses = ["blocked", "blockedTerminal"];
        if (!blockedStatuses.includes(subagent.status))
            continue;
        const ageMs = ageSince(subagent.updatedAt, tickStartedAt);
        if (ageMs < thresholdMs)
            continue;
        await recordControllerEvent(runtime, node.goalId, "staleState.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            nodeStatus: node.status,
            subagentStatus: subagent.status,
            ageMs,
            thresholdMs,
        }, tickStartedAt);
        // Diagnostic only — do not change node/subagent status.
    }
}
function controllerStateAgeMs(node, subagent, nowIso) {
    const nowMs = Date.parse(nowIso);
    const timestamps = [node.updatedAt, subagent.updatedAt]
        .map((value) => Date.parse(value))
        .filter((value) => Number.isFinite(value));
    if (!Number.isFinite(nowMs) || timestamps.length === 0)
        return 0;
    return Math.max(0, nowMs - Math.max(...timestamps));
}
async function reconcileStaleRunnerStartingNodes(runtime, goalId, options, result, tickStartedAt) {
    const thresholdMs = options.staleStateThresholdMs ?? DEFAULT_STALE_CONTROLLER_STATE_MS;
    if (thresholdMs <= 0)
        return;
    const state = await runtime.getGoalOrchestrationState(goalId);
    for (const node of state.nodes) {
        const runnerStarting = node.status === "running" && node.lifecyclePhase === "runnerStarting";
        const runnerPreparing = node.status === "running" && (node.lifecyclePhase === "resourcesCreating" || node.lifecyclePhase === "resourcesReady");
        const retryableBlockedRunnerStart = isRetryableStaleRunnerStartingBlock(node);
        const retryableInitialAllocationBlock = isRetryableInitialWorkspaceAllocationBlock(node);
        if (!runnerStarting && !runnerPreparing && !retryableBlockedRunnerStart && !retryableInitialAllocationBlock)
            continue;
        if (state.subagents.some((subagent) => subagent.nodeId === node.nodeId))
            continue;
        const ageMs = runnerStarting ? runnerStartingStateAgeMs(node, tickStartedAt) : ageSince(node.updatedAt, tickStartedAt);
        const requiredAgeMs = runnerStarting || retryableInitialAllocationBlock ? thresholdMs : INTEGRATION_RETRY_COOLDOWN_MS;
        if (ageMs < requiredAgeMs)
            continue;
        await recordControllerEvent(runtime, node.goalId, "staleRunnerStarting.detected", {
            nodeId: node.nodeId,
            nodeStatus: node.status,
            lifecyclePhase: node.lifecyclePhase,
            retryingBlockedStart: retryableBlockedRunnerStart || retryableInitialAllocationBlock,
            ageMs,
            thresholdMs: requiredAgeMs,
            preparedSubagentId: node.preparedResources?.subagentId,
            workspacePath: node.preparedResources?.workspacePath,
            branch: node.preparedResources?.branch,
        }, tickStartedAt);
        let allocation;
        if (!hasConcretePreparedResource(node.preparedResources ?? {})) {
            try {
                allocation = await options.workspaceAllocator?.({ goalId, node, state, adapterId: options.adapter.adapterId, tickStartedAt });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const summary = `workspace allocation failed while recovering stale ${node.lifecyclePhase ?? "runner preparation"} state: ${errorMessage}`;
                const blockedNode = withNodePatch(node, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: summary, updatedAt: tickStartedAt });
                await runtime.saveGoalDagNode(blockedNode);
                await recordControllerEvent(runtime, node.goalId, "staleRunnerStarting.blocked", {
                    nodeId: node.nodeId,
                    reason: summary,
                }, tickStartedAt);
                result.blocked.push(blockedNode);
                continue;
            }
        }
        const preparedResources = {
            ...(node.preparedResources ?? {}),
            subagentId: node.preparedResources?.subagentId ?? allocation?.subagentId ?? `subagent-${node.slug || node.nodeId}`,
            adapterId: options.adapter.adapterId,
            workspacePath: node.preparedResources?.workspacePath ?? allocation?.cwd,
            branch: node.preparedResources?.branch ?? allocation?.branch,
            ref: node.preparedResources?.ref ?? allocation?.ref,
            modelArg: metadataString(allocation?.metadata, "modelArg") ?? node.preparedResources?.modelArg ?? node.modelArg,
            modelScenario: metadataString(allocation?.metadata, "modelScenario") ?? node.preparedResources?.modelScenario ?? node.modelScenario,
            modelClass: metadataString(allocation?.metadata, "modelClass") ?? node.preparedResources?.modelClass ?? node.modelClass,
            modelResolution: metadataModelResolution(allocation?.metadata) ?? node.preparedResources?.modelResolution ?? node.modelResolution,
            thinkingLevel: metadataString(allocation?.metadata, "thinkingLevel") ?? node.preparedResources?.thinkingLevel ?? node.thinkingLevel,
            metadata: { ...(node.preparedResources?.metadata ?? {}), ...(allocation?.metadata ?? {}) },
            createdAt: node.preparedResources?.createdAt ?? tickStartedAt,
            updatedAt: tickStartedAt,
        };
        if (!hasConcretePreparedResource(preparedResources)) {
            const summary = "stale runnerStarting state has no durable prepared resources to restart safely";
            const blockedNode = withNodePatch(node, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: summary, updatedAt: tickStartedAt });
            await runtime.saveGoalDagNode(blockedNode);
            await recordControllerEvent(runtime, node.goalId, "staleRunnerStarting.blocked", {
                nodeId: node.nodeId,
                reason: summary,
            }, tickStartedAt);
            result.blocked.push(blockedNode);
            continue;
        }
        try {
            const started = await startGoalSubagentWithTimeout(runtime, options, options.adapter, node, {
                subagentId: preparedResources.subagentId,
                cwd: preparedResources.workspacePath,
                branch: preparedResources.branch,
                ref: preparedResources.ref,
                systemPrompt: allocation?.systemPrompt ?? options.systemPrompt,
                initialPrompt: allocation?.initialPrompt ?? options.renderInitialPrompt?.({ goalId, node, state }) ?? renderDefaultInitialPrompt(node),
                preparedResources,
                metadata: { ...(options.metadata ?? {}), ...(preparedResources.metadata ?? {}) },
                now: tickStartedAt,
                thinkingLevel: preparedResources.thinkingLevel ?? node.thinkingLevel,
            }, tickStartedAt);
            await recordControllerEvent(runtime, node.goalId, "staleRunnerStarting.restarted", {
                nodeId: node.nodeId,
                subagentId: started.subagentId,
                workspacePath: started.workspacePath,
                branch: started.branch,
                ageMs,
                thresholdMs: requiredAgeMs,
            }, tickStartedAt);
            result.started.push(started);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const summary = isProviderLimitError(errorMessage)
                ? quotaBlockedSummary(errorMessage)
                : unhandledScenarioBlockedSummary(`stale runnerStarting restart failed: ${errorMessage}`);
            const blockedNode = withNodePatch(node, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: summary, updatedAt: tickStartedAt });
            await runtime.saveGoalDagNode(blockedNode);
            await recordControllerEvent(runtime, node.goalId, "staleRunnerStarting.restartFailed", {
                nodeId: node.nodeId,
                subagentId: preparedResources.subagentId,
                reason: summary,
            }, tickStartedAt);
            result.blocked.push(blockedNode);
        }
    }
}
function runnerStartingStateAgeMs(node, nowIso) {
    const nowMs = Date.parse(nowIso);
    const timestamps = [node.updatedAt, node.preparedResources?.updatedAt, node.preparedResources?.createdAt]
        .map((value) => value ? Date.parse(value) : Number.NaN)
        .filter((value) => Number.isFinite(value));
    if (!Number.isFinite(nowMs) || timestamps.length === 0)
        return 0;
    return Math.max(0, nowMs - Math.max(...timestamps));
}
function isRetryableStaleRunnerStartingBlock(node) {
    const summary = node.lastValidationSummary ?? "";
    return node.status === "blocked" && (/stale runnerStarting restart failed: Background goal session cwd does not exist/i.test(summary) ||
        /workspace allocation failed while recovering stale (?:resourcesCreating|resourcesReady) state/i.test(summary));
}
function isRetryableInitialWorkspaceAllocationBlock(node) {
    const summary = node.lastValidationSummary ?? "";
    return node.status === "blocked" &&
        node.lifecyclePhase === "terminal" &&
        /^workspace allocation failed:/i.test(summary);
}
async function tryHandleAbnormalObservation(runtime, options, state, node, subagent, result, tickStartedAt, observation) {
    if (!options.exceptionHandler)
        return false;
    let decision = await options.exceptionHandler({
        goalId: node.goalId,
        node,
        subagent,
        resources: node.preparedResources,
        observation,
        recentMatchingFailures: countMatchingAbnormalObservations(state, observation),
        previousDecisions: previousRecoveryDecisionsForNode(state, node.nodeId),
        retryCount: subagent.retryCount ?? 0,
        maxRetries: options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT,
        now: tickStartedAt,
    });
    const loopSignature = recoveryLoopSignature(options.adapter.adapterId, observation, decision);
    const previousLoopCount = countMatchingRecoveryLoopDecisions(state, node.nodeId, loopSignature);
    decision = {
        ...decision,
        evidence: {
            ...(decision.evidence ?? {}),
            recoveryLoopSignature: loopSignature,
            recoveryLoopCount: previousLoopCount + 1,
        },
    };
    const loopLimit = decision.maxRetries ?? options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    if (shouldOpenRecoveryCircuitBreaker(decision, previousLoopCount, loopLimit)) {
        decision = {
            ...decision,
            action: "markNodeBlocked",
            ruleId: decision.ruleId ?? "recovery-circuit-breaker",
            reason: `recovery circuit breaker opened after ${previousLoopCount} repeated ${decision.action} decision(s) for signature ${loopSignature}: ${decision.reason}`,
            confidence: "high",
            evidence: {
                ...(decision.evidence ?? {}),
                circuitBreakerOpen: true,
                previousLoopCount,
                loopLimit,
            },
        };
    }
    await recordControllerEvent(runtime, node.goalId, "exception.decision", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        observation: observation.kind,
        action: decision.action,
        reason: decision.reason,
        ruleId: decision.ruleId,
        confidence: decision.confidence,
        recoveryLoopSignature: loopSignature,
        recoveryLoopCount: previousLoopCount + 1,
        circuitBreakerOpen: Boolean(decision.evidence?.circuitBreakerOpen),
    }, tickStartedAt);
    const nodeWithDecision = recordRecoveryDecisionOnNode(node, decision, { phase: "controllerJudging", now: tickStartedAt });
    const subagentWithDecision = withSubagentPatch(subagent, {
        lastRecoveryDecision: decision,
        recoveryLoopSignature: loopSignature,
        integrationStatus: decision.reason,
        updatedAt: tickStartedAt,
    });
    if (decision.action === "delegateToLegacyRecovery") {
        await runtime.saveGoalDagNode(nodeWithDecision);
        await runtime.saveGoalSubagent(subagentWithDecision);
        result.synced.push(subagentWithDecision);
        return false;
    }
    if (decision.action === "sendPromptToSameSession" || decision.action === "restartRunnerSameSession") {
        const prompt = decision.prompt ?? buildSameSessionRecoveryPrompt(node, decision);
        let followed;
        try {
            followed = await sendGoalSubagentPromptWithTimeout(runtime, options, options.adapter, subagentWithDecision, prompt, tickStartedAt);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await degradePromptDispatchFailure(runtime, nodeWithDecision, subagentWithDecision, result, tickStartedAt, `exception recovery prompt dispatch failed: ${errorMessage}`, error);
            return true;
        }
        const runningSubagent = withSubagentPatch(followed, {
            status: "running",
            lastRecoveryDecision: decision,
            integrationStatus: decision.reason,
            retryCount: (subagent.retryCount ?? 0) + 1,
            lastActivityAt: tickStartedAt,
            updatedAt: tickStartedAt,
        });
        const runningNode = withGoalDagNodeLifecyclePhase(recordRecoveryDecisionOnNode(nodeWithDecision, decision, { phase: "runnerActive", status: "running", now: tickStartedAt }), "runnerActive", { status: "running", now: tickStartedAt });
        await runtime.saveGoalSubagent(runningSubagent);
        await runtime.saveGoalDagNode(runningNode);
        result.followups.push(runningSubagent);
        result.synced.push(runningSubagent);
        return true;
    }
    if (decision.action === "restartRunnerSameWorktreeNewSession") {
        return startRecoverySubagentOnSameResources(runtime, options, state, nodeWithDecision, subagentWithDecision, result, tickStartedAt, decision);
    }
    if (decision.action === "supersedeResourcesAndRestart") {
        return startRecoverySubagentWithSupersededResources(runtime, options, state, nodeWithDecision, subagentWithDecision, result, tickStartedAt, decision);
    }
    if (decision.action === "markNodeBlocked" || decision.action === "askUser" || decision.action === "proposeRecoveryRule") {
        const blockedSubagent = withSubagentPatch(subagentWithDecision, { status: "blocked", integrationStatus: decision.reason, updatedAt: tickStartedAt });
        const blockedNode = recordRecoveryDecisionOnNode(nodeWithDecision, decision, { phase: "terminal", status: "blocked", now: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    // invokeControllerModel is a durable diagnostic decision. If the handler did
    // not translate it into a concrete bounded action, preserve compatibility by
    // falling back to the legacy recovery branch after persisting the decision.
    await runtime.saveGoalDagNode(nodeWithDecision);
    await runtime.saveGoalSubagent(subagentWithDecision);
    result.synced.push(subagentWithDecision);
    return false;
}
function countMatchingAbnormalObservations(state, observation) {
    const signature = normalizeExceptionSignature(observation);
    const observations = [
        ...state.nodes.map((node) => node.lastAdapterObservation),
        ...state.subagents.map((subagent) => subagent.lastAdapterObservation),
        observation,
    ].filter((item) => Boolean(item));
    const unique = new Set();
    for (const item of observations) {
        if (normalizeExceptionSignature(item) === signature)
            unique.add(`${item.adapterId}:${item.kind}:${item.at}:${item.error ?? item.summary ?? ""}`);
    }
    return unique.size;
}
function previousRecoveryDecisionsForNode(state, nodeId) {
    return [
        ...state.nodes.filter((node) => node.nodeId === nodeId).map((node) => node.lastRecoveryDecision),
        ...state.subagents.filter((subagent) => subagent.nodeId === nodeId).map((subagent) => subagent.lastRecoveryDecision),
    ].filter((item) => Boolean(item));
}
function recoveryLoopSignature(adapterId, observation, decision) {
    return [adapterId, observation.kind, normalizeExceptionSignature(observation), decision.action].join(":");
}
function countMatchingRecoveryLoopDecisions(state, nodeId, signature) {
    return previousRecoveryDecisionsForNode(state, nodeId).filter((decision) => decision.evidence?.recoveryLoopSignature === signature).length;
}
function shouldOpenRecoveryCircuitBreaker(decision, previousLoopCount, loopLimit) {
    if (!Number.isFinite(loopLimit) || loopLimit <= 0)
        return false;
    if (["markNodeBlocked", "askUser", "proposeRecoveryRule", "delegateToLegacyRecovery"].includes(decision.action))
        return false;
    return previousLoopCount >= loopLimit;
}
function buildSameSessionRecoveryPrompt(node, decision) {
    return [
        `[SYSTEM RECOVERY: ${decision.action}]`,
        `The controller is preserving this subagent session and prepared workspace.`,
        `Observed issue: ${decision.reason}`,
        `Continue the DAG node objective: "${node.objective}"`,
        `When done, report exactly: SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If blocked, report exactly: SUBAGENT_BLOCKED: <specific blocker and needed input/state change>`,
    ].join("\n");
}
async function startRecoverySubagentOnSameResources(runtime, options, state, node, subagent, result, tickStartedAt, decision) {
    const retryCount = (subagent.retryCount ?? 0) + 1;
    const replacementSubagentId = uniqueReplacementSubagentId(state.subagents, subagent.subagentId, retryCount);
    const resources = recoveryPreparedResources(node, subagent, tickStartedAt, {
        subagentId: replacementSubagentId,
        clearSession: true,
        metadata: {
            recoveryAction: decision.action,
            recoveryFor: subagent.subagentId,
            previousSessionId: subagent.sessionId,
            previousSessionFile: subagent.sessionFile,
            recoveryReason: decision.reason,
        },
    });
    if (!resources.workspacePath && !resources.branch && !resources.ref) {
        const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: `cannot restart on same resources: no prepared worktree/branch/ref. ${decision.reason}` });
        const blockedNode = recordRecoveryDecisionOnNode(node, decision, { phase: "terminal", status: "blocked", now: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    const terminalSubagent = withSubagentPatch(subagent, {
        status: "failed",
        integrationStatus: `replaced by ${replacementSubagentId}: ${decision.reason}`,
        retryCount,
        lastRecoveryDecision: decision,
        updatedAt: tickStartedAt,
    });
    await runtime.saveGoalSubagent(terminalSubagent);
    const started = await startGoalSubagentWithTimeout(runtime, options, options.adapter, node, {
        subagentId: replacementSubagentId,
        cwd: resources.workspacePath,
        branch: resources.branch,
        ref: resources.ref,
        systemPrompt: options.systemPrompt,
        initialPrompt: decision.prompt ?? buildNewSessionSameWorktreePrompt(node, subagent, decision, retryCount, decision.maxRetries ?? options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT),
        preparedResources: resources,
        metadata: { ...(options.metadata ?? {}), ...(resources.metadata ?? {}) },
        now: tickStartedAt,
        thinkingLevel: resources.thinkingLevel ?? node.thinkingLevel,
    }, tickStartedAt);
    const replacement = withSubagentPatch(started, {
        retryCount,
        lastRecoveryDecision: decision,
        integrationStatus: `same-resource recovery ${retryCount}/${decision.maxRetries ?? options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT}: ${decision.reason}`,
        lastActivityAt: tickStartedAt,
        updatedAt: tickStartedAt,
    });
    await runtime.saveGoalSubagent(replacement);
    await recordControllerEvent(runtime, node.goalId, "recovery.sameResourcesStarted", {
        nodeId: node.nodeId,
        previousSubagentId: subagent.subagentId,
        subagentId: replacement.subagentId,
        action: decision.action,
        workspacePath: replacement.workspacePath,
        branch: replacement.branch,
        ruleId: decision.ruleId,
        reason: decision.reason,
    }, tickStartedAt);
    result.synced.push(terminalSubagent);
    result.started.push(replacement);
    return true;
}
async function startRecoverySubagentWithSupersededResources(runtime, options, state, node, subagent, result, tickStartedAt, decision) {
    if (!options.workspaceAllocator) {
        const summary = `cannot supersede resources without a controller workspace allocator: ${decision.reason}`;
        const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, lastRecoveryDecision: decision });
        const blockedNode = recordRecoveryDecisionOnNode(node, decision, { phase: "terminal", status: "blocked", now: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
    const retryCount = (subagent.retryCount ?? 0) + 1;
    const allocation = await options.workspaceAllocator({ goalId: node.goalId, node, state, adapterId: options.adapter.adapterId, tickStartedAt });
    const replacementSubagentId = allocation?.subagentId ?? uniqueReplacementSubagentId(state.subagents, subagent.subagentId, retryCount);
    const resources = {
        subagentId: replacementSubagentId,
        adapterId: options.adapter.adapterId,
        workspacePath: allocation?.cwd,
        branch: allocation?.branch,
        ref: allocation?.ref,
        modelArg: metadataString(allocation?.metadata, "modelArg") ?? node.preparedResources?.modelArg ?? node.modelArg,
        modelScenario: metadataString(allocation?.metadata, "modelScenario") ?? node.preparedResources?.modelScenario ?? node.modelScenario,
        modelClass: metadataString(allocation?.metadata, "modelClass") ?? node.preparedResources?.modelClass ?? node.modelClass,
        modelResolution: metadataModelResolution(allocation?.metadata) ?? node.preparedResources?.modelResolution ?? node.modelResolution,
        thinkingLevel: metadataString(allocation?.metadata, "thinkingLevel") ?? node.preparedResources?.thinkingLevel ?? node.thinkingLevel,
        metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}), recoveryAction: decision.action, recoveryFor: subagent.subagentId },
        createdAt: tickStartedAt,
        updatedAt: tickStartedAt,
    };
    const supersededNode = supersedePreparedResourcesOnNode(node, resources, {
        phase: "resourcesReady",
        reason: decision.reason,
        supersededBy: replacementSubagentId,
        now: tickStartedAt,
    });
    await runtime.saveGoalDagNode(withGoalDagNodeLifecyclePhase(supersededNode, "runnerStarting", { status: "running", now: tickStartedAt }));
    const terminalSubagent = withSubagentPatch(subagent, {
        status: "failed",
        integrationStatus: `resources superseded by ${replacementSubagentId}: ${decision.reason}`,
        retryCount,
        lastRecoveryDecision: decision,
    });
    await runtime.saveGoalSubagent(terminalSubagent);
    const started = await startGoalSubagentWithTimeout(runtime, options, options.adapter, supersededNode, {
        subagentId: replacementSubagentId,
        cwd: resources.workspacePath,
        branch: resources.branch,
        ref: resources.ref,
        systemPrompt: allocation?.systemPrompt ?? options.systemPrompt,
        initialPrompt: decision.prompt ?? allocation?.initialPrompt ?? buildNewSessionSameWorktreePrompt(node, subagent, decision, retryCount, decision.maxRetries ?? options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT),
        preparedResources: resources,
        metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}) },
        now: tickStartedAt,
        thinkingLevel: resources.thinkingLevel ?? node.thinkingLevel,
    }, tickStartedAt);
    const replacement = withSubagentPatch(started, {
        retryCount,
        lastRecoveryDecision: decision,
        integrationStatus: `superseded-resource recovery ${retryCount}: ${decision.reason}`,
        lastActivityAt: tickStartedAt,
        updatedAt: tickStartedAt,
    });
    await runtime.saveGoalSubagent(replacement);
    await recordControllerEvent(runtime, node.goalId, "recovery.resourcesSuperseded", {
        nodeId: node.nodeId,
        previousSubagentId: subagent.subagentId,
        subagentId: replacement.subagentId,
        workspacePath: replacement.workspacePath,
        branch: replacement.branch,
        ruleId: decision.ruleId,
        reason: decision.reason,
    }, tickStartedAt);
    result.synced.push(terminalSubagent);
    result.started.push(replacement);
    return true;
}
function buildNewSessionSameWorktreePrompt(node, previous, decision, retryCount, maxRetries) {
    return [
        `[SYSTEM RECOVERY: ${decision.action}]`,
        `The previous runner/session for ${previous.subagentId} is not reusable, but the controller is preserving the same prepared worktree and branch.`,
        `Observed issue: ${decision.reason}`,
        `First inspect current workspace state only as needed (for example git status/diff and relevant files).`,
        `Then continue the DAG node objective: "${node.objective}"`,
        node.scope ? `Scope: ${node.scope}` : undefined,
        node.expectedOutputs.length ? `Expected outputs: ${node.expectedOutputs.join(", ")}` : undefined,
        node.validators.length ? `Validators: ${node.validators.join(", ")}` : undefined,
        `When done, report exactly: SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If blocked, report exactly: SUBAGENT_BLOCKED: <specific blocker and needed input/state change>`,
        `Recovery attempt ${retryCount}/${maxRetries}.`,
    ].filter((line) => Boolean(line)).join("\n");
}
function metadataString(metadata, key) {
    const value = metadata?.[key];
    return typeof value === "string" && value ? value : undefined;
}
function metadataModelResolution(metadata) {
    const value = metadata?.modelResolution;
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function recoveryPreparedResources(node, subagent, now, options = {}) {
    const base = node.preparedResources ?? {};
    return {
        ...base,
        subagentId: options.subagentId ?? base.subagentId ?? subagent.subagentId,
        adapterId: base.adapterId ?? subagent.harnessAdapterId,
        workspacePath: base.workspacePath ?? subagent.workspacePath,
        branch: base.branch ?? subagent.branch,
        ref: base.ref ?? subagent.ref,
        sessionId: options.clearSession ? undefined : base.sessionId ?? subagent.sessionId,
        sessionFile: options.clearSession ? undefined : base.sessionFile ?? subagent.sessionFile,
        modelArg: options.modelArg ?? base.modelArg ?? node.modelArg,
        modelScenario: base.modelScenario ?? node.modelScenario,
        modelClass: options.modelClass ?? base.modelClass ?? node.modelClass,
        modelResolution: options.modelResolution ?? base.modelResolution ?? node.modelResolution,
        thinkingLevel: options.thinkingLevel ?? base.thinkingLevel ?? node.thinkingLevel,
        metadata: { ...(base.metadata ?? {}), ...(options.metadata ?? {}) },
        createdAt: base.createdAt ?? subagent.createdAt,
        updatedAt: now,
    };
}
function hasConcretePreparedResource(resources) {
    return Boolean(resources.workspacePath || resources.branch || resources.ref || resources.sessionId || resources.sessionFile);
}
async function tryRetryBlockedIntegration(runtime, options, state, node, subagent, result, tickStartedAt) {
    if (!options.integrator)
        return false;
    if (subagent.integrationState !== "failed")
        return false;
    const reason = subagent.integrationError ?? subagent.integrationStatus ?? node.lastValidationSummary ?? "integration failed";
    if (!isRetryableIntegrationBlocker(reason))
        return false;
    const ageMs = ageSince(subagent.updatedAt, tickStartedAt);
    if (ageMs < INTEGRATION_RETRY_COOLDOWN_MS)
        return false;
    await recordControllerEvent(runtime, node.goalId, "integration.retrying", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        reason,
        ageMs,
        cooldownMs: INTEGRATION_RETRY_COOLDOWN_MS,
    }, tickStartedAt);
    const validationSummary = latestControllerValidationPassSummary(subagent) ?? "previous controller validation passed; retrying integration";
    const retrySubagent = withSubagentPatch(subagent, {
        status: "selfReportedComplete",
        integrationStatus: `retrying previous controller integration blocker: ${reason}`,
        integrationError: reason,
        updatedAt: tickStartedAt,
    });
    await integrateOrCompleteValidatedSubagent(runtime, options, state, node, retrySubagent, result, tickStartedAt, validationSummary, undefined);
    return true;
}
function isRetryableIntegrationBlocker(reason) {
    return (/controller workspace has uncommitted changes; cannot (?:integrate|promote) safely/i.test(reason) ||
        /controller workspace is not inside a Git repository/i.test(reason) ||
        /submodule publish blocked/i.test(reason) ||
        /trustedSubmoduleUrlPatterns/i.test(reason) ||
        /not on any durable remote ref/i.test(reason) ||
        /retained ref/i.test(reason));
}
function latestControllerValidationPassSummary(subagent) {
    const results = subagent.controllerValidationResults ?? [];
    for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        if (/controller validation passed/i.test(result))
            return result;
    }
    return undefined;
}
function ageSince(timestamp, nowIso) {
    if (!timestamp)
        return Number.POSITIVE_INFINITY;
    const nowMs = Date.parse(nowIso);
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(nowMs) || !Number.isFinite(timestampMs))
        return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - timestampMs);
}
async function tryRecoverBlockedSubagent(runtime, options, state, node, subagent, result, tickStartedAt) {
    const blockedReason = subagent.integrationStatus ?? subagent.selfReportedResult ?? node.lastValidationSummary ?? "blocked";
    if (isProviderLimitError(blockedReason))
        return false;
    if (isValidationFollowupCappedSummary(blockedReason)) {
        return tryStartValidationCappedReplacement(runtime, options, state, node, subagent, result, tickStartedAt, blockedReason);
    }
    const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    const retryCount = subagent.retryCount ?? 0;
    if (retryCount >= maxRetries) {
        const summary = `blockedTerminal: recovery retries exhausted (${retryCount}/${maxRetries}). ${blockedReason}`;
        const terminalSubagent = withSubagentPatch(subagent, {
            status: "blockedTerminal",
            integrationStatus: summary,
            retryCount,
            updatedAt: tickStartedAt,
        });
        const terminalNode = withNodePatch(node, {
            status: "blockedTerminal",
            lastValidationSummary: summary,
            updatedAt: tickStartedAt,
        });
        await runtime.saveGoalSubagent(terminalSubagent);
        await runtime.saveGoalDagNode(terminalNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.blockedTerminal", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            retry: retryCount,
            maxRetries,
            reason: blockedReason,
        }, tickStartedAt);
        result.blocked.push(terminalNode);
        result.synced.push(terminalSubagent);
        return true;
    }
    try {
        const prompt = buildBlockedNodeRecoveryPrompt(node, blockedReason, retryCount, maxRetries);
        const followed = await sendGoalSubagentPromptWithTimeout(runtime, options, options.adapter, subagent, prompt, tickStartedAt);
        const summary = `active-goal blocked-node recovery ${retryCount + 1}/${maxRetries}: ${blockedReason}`;
        const runningSubagent = withSubagentPatch(followed, {
            status: "running",
            integrationStatus: summary,
            retryCount: retryCount + 1,
            lastActivityAt: tickStartedAt,
            updatedAt: tickStartedAt,
        });
        const runningNode = withNodePatch(node, { status: "running", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(runningSubagent);
        await runtime.saveGoalDagNode(runningNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.sent", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            mode: "blocked-node",
            retry: retryCount + 1,
            maxRetries,
            reason: blockedReason,
        }, tickStartedAt);
        result.followups.push(runningSubagent);
        result.synced.push(runningSubagent);
        return true;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (error instanceof ControllerActionTimeoutError) {
            await degradePromptDispatchFailure(runtime, node, subagent, result, tickStartedAt, `blocked-node recovery prompt dispatch failed: ${errorMessage}`, error);
            return true;
        }
        if (!isProviderLimitError(errorMessage))
            throw error;
        const summary = quotaBlockedSummary(errorMessage);
        const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
        const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
        await runtime.saveGoalSubagent(blockedSubagent);
        await runtime.saveGoalDagNode(blockedNode);
        await recordControllerEvent(runtime, subagent.goalId, "recovery.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            reason: summary,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        result.synced.push(blockedSubagent);
        return true;
    }
}
function isValidationFollowupCappedSummary(summary) {
    return /repeated identical controller validation failure/i.test(summary) && /follow-ups are capped/i.test(summary);
}
function isControllerActionRequiredValidationCap(node, subagent, summary) {
    const allowedPaths = node.validation?.allowedPaths ?? [];
    if (hasAllowedPathParentPolicyConflict(allowedPaths, summary))
        return true;
    if (/missing evidence:\s*implementation-diff-present/i.test(summary)) {
        return (subagent.controllerValidationResults ?? []).some((result) => hasAllowedPathParentPolicyConflict(allowedPaths, result));
    }
    return false;
}
function hasAllowedPathParentPolicyConflict(allowedPaths, validationText) {
    if (allowedPaths.length === 0 || !/changed files outside allowed paths/i.test(validationText))
        return false;
    const outsidePaths = extractChangedFilesOutsideAllowedPaths(validationText);
    return outsidePaths.some((outsidePath) => allowedPaths.some((allowedPath) => isParentRepoPath(outsidePath, allowedPath)));
}
function extractChangedFilesOutsideAllowedPaths(validationText) {
    const paths = [];
    const pattern = /changed files outside allowed paths:\s*([^\n]+)/gi;
    for (const match of validationText.matchAll(pattern)) {
        const rawSegment = match[1]
            ?.replace(/\brepeated identical controller validation failure\b.*$/i, "")
            .replace(/\bautomatic same-session follow-ups\b.*$/i, "")
            .trim();
        if (!rawSegment)
            continue;
        for (const value of rawSegment.split(/[;,]/)) {
            const normalized = normalizeRepoPath(value);
            if (normalized)
                paths.push(normalized);
        }
    }
    return paths;
}
function isParentRepoPath(parentPath, childPattern) {
    const parent = normalizeRepoPath(parentPath);
    const child = staticRepoPathPrefix(childPattern);
    return Boolean(parent && child && child.startsWith(`${parent}/`));
}
function staticRepoPathPrefix(pattern) {
    const normalized = normalizeRepoPath(pattern);
    if (!normalized)
        return undefined;
    const globIndex = normalized.search(/[*?[\]{}]/);
    return (globIndex >= 0 ? normalized.slice(0, globIndex) : normalized).replace(/\/+$/u, "") || undefined;
}
function normalizeRepoPath(value) {
    const normalized = value
        .trim()
        .replace(/^`|`$/g, "")
        .replace(/^["']|["']$/g, "")
        .replace(/^[.][/\\]/, "")
        .replace(/[).,]+$/g, "")
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/\/+$/u, "");
    return normalized.length > 0 ? normalized : undefined;
}
function canRestartOnSameResources(node, subagent) {
    return Boolean(node.preparedResources?.workspacePath || node.preparedResources?.branch || node.preparedResources?.ref || subagent.workspacePath || subagent.branch || subagent.ref);
}
async function tryStartValidationCappedReplacement(runtime, options, state, node, subagent, result, tickStartedAt, summary) {
    if (isControllerActionRequiredValidationCap(node, subagent, summary)) {
        await recordControllerEvent(runtime, node.goalId, "validation.replacementSuppressed", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            summary,
            reason: "controller-action-required",
        }, tickStartedAt);
        return false;
    }
    const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    const replacementCount = validationCappedReplacementCount(state, node.nodeId);
    const replacementAttempt = replacementCount + 1;
    if (replacementCount >= maxRetries || !canRestartOnSameResources(node, subagent))
        return false;
    const replacementBaseSubagent = { ...subagent, retryCount: replacementAttempt - 1 };
    const decision = {
        action: "restartRunnerSameWorktreeNewSession",
        reason: summary,
        at: tickStartedAt,
        ruleId: "validation-followup-cap-replacement",
        confidence: "high",
        retryCount: replacementAttempt,
        maxRetries,
        prompt: buildValidationCappedReplacementPrompt(node, subagent, summary, replacementAttempt, maxRetries),
        evidence: {
            validationFollowupCapped: true,
            previousSubagentId: subagent.subagentId,
            previousSelfReportedResult: subagent.selfReportedResult,
            recentValidationResults: subagent.controllerValidationResults?.slice(-5),
        },
    };
    return startRecoverySubagentOnSameResources(runtime, options, state, node, replacementBaseSubagent, result, tickStartedAt, decision);
}
function validationCappedReplacementCount(state, nodeId) {
    return state.subagents.filter((subagent) => subagent.nodeId === nodeId &&
        subagent.lastRecoveryDecision?.ruleId === "validation-followup-cap-replacement" &&
        /^same-resource recovery\b/.test(subagent.integrationStatus ?? "")).length;
}
async function tryRestartInterruptedValidationCappedReplacement(runtime, options, state, node, subagent, result, tickStartedAt) {
    const previousDecision = subagent.lastRecoveryDecision;
    if (previousDecision?.ruleId !== "validation-followup-cap-replacement")
        return false;
    if (!canRestartOnSameResources(node, subagent))
        return false;
    const maxRetries = previousDecision.maxRetries ?? options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
    const replacementCount = validationCappedReplacementCount(state, node.nodeId);
    const replacementAttempt = replacementCount + 1;
    if (replacementCount >= maxRetries)
        return false;
    const reason = previousDecision.reason ?? subagent.integrationStatus ?? node.lastValidationSummary ?? "validation follow-up cap replacement was interrupted";
    if (isControllerActionRequiredValidationCap(node, subagent, reason)) {
        await recordControllerEvent(runtime, node.goalId, "validation.replacementSuppressed", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            summary: reason,
            reason: "controller-action-required",
            interruptedReplacementRestart: true,
        }, tickStartedAt);
        return false;
    }
    const decision = {
        ...previousDecision,
        at: tickStartedAt,
        retryCount: replacementAttempt,
        maxRetries,
        prompt: previousDecision.prompt ?? buildValidationCappedReplacementPrompt(node, subagent, reason, replacementAttempt, maxRetries),
        evidence: {
            ...(previousDecision.evidence ?? {}),
            interruptedReplacementRestart: true,
            previousSubagentStatus: subagent.status,
            previousIntegrationStatus: subagent.integrationStatus,
        },
    };
    const replacementBaseSubagent = { ...subagent, retryCount: replacementAttempt - 1, integrationStatus: reason };
    return startRecoverySubagentOnSameResources(runtime, options, state, node, replacementBaseSubagent, result, tickStartedAt, decision);
}
async function degradePromptDispatchFailure(runtime, node, subagent, result, tickStartedAt, summary, error) {
    const failedAttempt = controllerActionAttemptFromError(error);
    const needsFollowupSubagent = withSubagentPatch(subagent, {
        status: "needsFollowup",
        integrationStatus: summary,
        attemptId: subagent.attemptId ?? (failedAttempt ? `${subagent.subagentId}-attempt-dispatch-${String(Date.parse(tickStartedAt)).replace(/[^0-9]/g, "") || "now"}` : undefined),
        attemptStartedAt: subagent.attemptStartedAt ?? (failedAttempt ? tickStartedAt : undefined),
        attemptCursor: subagent.attemptCursor ?? (failedAttempt ? { at: tickStartedAt, source: "prompt-dispatch" } : undefined),
        lastActionAttempt: failedAttempt ?? subagent.lastActionAttempt,
        updatedAt: tickStartedAt,
    });
    const needsFollowupNode = withNodePatch(node, { status: "needsFollowup", lastValidationSummary: summary, updatedAt: tickStartedAt });
    await runtime.saveGoalDagNode(needsFollowupNode);
    await runtime.saveGoalSubagent(needsFollowupSubagent);
    await recordControllerEvent(runtime, node.goalId, "recovery.actionDegraded", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        actionId: failedAttempt?.actionId,
        actionKind: failedAttempt?.actionKind ?? "promptDispatch",
        summary,
        error: error instanceof Error ? error.message : String(error),
    }, tickStartedAt);
    result.followups.push(needsFollowupSubagent);
    result.synced.push(needsFollowupSubagent);
    return needsFollowupSubagent;
}
function controllerActionAttemptFromError(error) {
    if (error instanceof ControllerActionTimeoutError) {
        return { ...error.actionAttempt, status: "timedOut", error: error.message };
    }
    return undefined;
}
function buildValidationCappedReplacementPrompt(node, previous, summary, retryCount, maxRetries) {
    return [
        `[SYSTEM RECOVERY: VALIDATION_FOLLOWUP_CAP_REPLACEMENT]`,
        `The previous runner/session ${previous.subagentId} repeatedly reported completion, but controller validation kept failing and same-session follow-ups are capped.`,
        `Do not trust the previous completion claim without re-verifying the workspace state.`,
        `Controller validation summary: ${summary}`,
        previous.selfReportedResult ? `Previous self-report: ${truncateForPrompt(previous.selfReportedResult, 2000)}` : undefined,
        `Preserve the same prepared worktree/branch and continue the DAG node objective: "${node.objective}"`,
        node.scope ? `Scope: ${node.scope}` : undefined,
        node.expectedOutputs.length ? `Expected outputs that must exist before reporting completion: ${node.expectedOutputs.join(", ")}` : undefined,
        node.validators.length ? `Validators to run before reporting completion: ${node.validators.join(", ")}` : undefined,
        `If a nested repository or submodule path is involved, verify that git commands are running inside that nested repository and not silently climbing to the parent worktree. Initialize/update missing submodules when appropriate before claiming files or branches exist.`,
        `When done, report exactly: SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>`,
        `If blocked, report exactly: SUBAGENT_BLOCKED: <specific blocker and needed input/state change>`,
        `Replacement recovery attempt ${retryCount}/${maxRetries}.`,
    ].filter((line) => Boolean(line)).join("\n");
}
async function validateOrHold(runtime, options, state, node, subagent, result, tickStartedAt) {
    const validatingNode = withNodePatch(node, { status: "controllerValidating", lifecyclePhase: "validating" });
    const validatingSubagent = withSubagentPatch(subagent, { status: "controllerValidating" });
    await runtime.saveGoalDagNode(validatingNode);
    await runtime.saveGoalSubagent(validatingSubagent);
    await recordControllerEvent(runtime, node.goalId, "validation.started", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        expectedOutputs: node.expectedOutputs.length,
        validators: node.validators.length,
    }, tickStartedAt);
    result.validating.push(validatingNode);
    if (!options.validator) {
        await recordControllerEvent(runtime, node.goalId, "validation.holding", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            reason: "no controller validator configured",
        }, tickStartedAt);
        return;
    }
    const validation = await options.validator({ goalId: node.goalId, node: validatingNode, subagent: validatingSubagent, state, tickStartedAt });
    const validationSummary = validation.summary ?? validation.validationSignals?.join("; ");
    const validationResults = appendValidationResults(validatingSubagent, validation);
    if (validation.status === "passed") {
        await recordControllerEvent(runtime, node.goalId, "validation.passed", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            summary: validationSummary,
            signals: validation.validationSignals?.length ?? 0,
        }, tickStartedAt);
        await integrateOrCompleteValidatedSubagent(runtime, options, state, validatingNode, validationResults, result, tickStartedAt, validationSummary, validation.validationSignals);
        return;
    }
    await recordControllerEvent(runtime, node.goalId, validation.status === "blocked" ? "validation.blocked" : "validation.failed", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        summary: validationSummary,
        signals: validation.validationSignals?.length ?? 0,
        followup: Boolean(validation.followupPrompt),
    }, tickStartedAt);
    if (validation.status === "blocked") {
        const blockedNode = withNodePatch(validatingNode, { status: "blocked", lastValidationSummary: validationSummary });
        const blockedSubagent = withSubagentPatch(validationResults, { status: "blocked" });
        await runtime.saveGoalDagNode(blockedNode);
        await runtime.saveGoalSubagent(blockedSubagent);
        result.blocked.push(blockedNode);
        return;
    }
    if (validation.followupPrompt) {
        const repeat = repeatedValidationFailure(validatingSubagent, validation);
        if (repeat.count > MAX_VALIDATION_FOLLOWUPS_FOR_SAME_FAILURE) {
            const repeatSummary = appendSummary(validationSummary, `repeated identical controller validation failure (${repeat.count} occurrences); automatic same-session follow-ups are capped at ${MAX_VALIDATION_FOLLOWUPS_FOR_SAME_FAILURE}`) ?? `repeated identical controller validation failure (${repeat.count} occurrences); automatic same-session follow-ups are capped at ${MAX_VALIDATION_FOLLOWUPS_FOR_SAME_FAILURE}`;
            await recordControllerEvent(runtime, node.goalId, "validation.followupCapped", {
                nodeId: node.nodeId,
                subagentId: subagent.subagentId,
                summary: repeatSummary,
                occurrences: repeat.count,
            }, tickStartedAt);
            const replacementStarted = await tryStartValidationCappedReplacement(runtime, options, state, validatingNode, validationResults, result, tickStartedAt, repeatSummary);
            if (replacementStarted)
                return;
            const blockedNode = withNodePatch(validatingNode, { status: "blocked", lastValidationSummary: repeatSummary });
            const blockedSubagent = withSubagentPatch(validationResults, {
                status: "blocked",
                integrationStatus: repeatSummary,
                retryCount: Math.max(validationResults.retryCount ?? 0, options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT),
            });
            await runtime.saveGoalDagNode(blockedNode);
            await runtime.saveGoalSubagent(blockedSubagent);
            result.blocked.push(blockedNode);
            return;
        }
        let followed;
        try {
            followed = await sendGoalSubagentPromptWithTimeout(runtime, options, options.adapter, validationResults, validation.followupPrompt, tickStartedAt);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const dispatchSummary = appendSummary(validationSummary, `controller validation follow-up dispatch failed: ${errorMessage}`) ?? `controller validation follow-up dispatch failed: ${errorMessage}`;
            await recordControllerEvent(runtime, node.goalId, "followup.dispatchFailed", {
                nodeId: node.nodeId,
                subagentId: subagent.subagentId,
                summary: dispatchSummary,
            }, tickStartedAt);
            await degradePromptDispatchFailure(runtime, validatingNode, validationResults, result, tickStartedAt, dispatchSummary, error);
            return;
        }
        const runningSubagent = withSubagentPatch(followed, { status: "running" });
        const runningNode = withNodePatch(validatingNode, { status: "running", lastValidationSummary: validationSummary });
        await runtime.saveGoalSubagent(runningSubagent);
        await runtime.saveGoalDagNode(runningNode);
        await recordControllerEvent(runtime, node.goalId, "followup.sent", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            summary: validationSummary,
        }, tickStartedAt);
        result.followups.push(runningSubagent);
        return;
    }
    const needsFollowupNode = withNodePatch(validatingNode, { status: "needsFollowup", lastValidationSummary: validationSummary });
    const needsFollowupSubagent = withSubagentPatch(validationResults, { status: "needsFollowup" });
    await runtime.saveGoalDagNode(needsFollowupNode);
    await runtime.saveGoalSubagent(needsFollowupSubagent);
    await recordControllerEvent(runtime, node.goalId, "followup.needed", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        summary: validationSummary,
    }, tickStartedAt);
    result.followups.push(needsFollowupSubagent);
}
async function integrateOrCompleteValidatedSubagent(runtime, options, state, node, subagent, result, tickStartedAt, validationSummary, validationSignals) {
    const requiresDependencyPropagation = nodeHasDownstreamDependents(state, node) && hasSubagentBranchOrWorkspaceEvidence(subagent);
    if (!nodeRequiresSubagentIntegration(node, subagent) && !requiresDependencyPropagation) {
        await completeValidatedSubagent(runtime, node, subagent, result, validationSummary, { integrationState: "not-required", integrationStatus: "integration not required" });
        return;
    }
    if (requiredSubagentIntegrationTerminalSuccess(subagent)) {
        await completeValidatedSubagent(runtime, node, subagent, result, validationSummary);
        return;
    }
    if (!options.integrator) {
        const message = "required subagent branch integration cannot run: no controller integrator is configured";
        const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: appendSummary(validationSummary, message) });
        const blockedSubagent = withSubagentPatch(subagent, {
            status: "blocked",
            integrationState: "failed",
            integrationStatus: message,
            integrationError: message,
        });
        await runtime.saveGoalDagNode(blockedNode);
        await runtime.saveGoalSubagent(blockedSubagent);
        await recordControllerEvent(runtime, node.goalId, "integration.blocked", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            reason: message,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        return;
    }
    const integratingNode = withNodePatch(node, { lifecyclePhase: "integrating", status: "controllerValidating" });
    await runtime.saveGoalDagNode(integratingNode);
    const integratingSubagent = withSubagentPatch(subagent, {
        integrationState: "integrating",
        integrationStatus: "integrating subagent branch into controller workspace",
    });
    await runtime.saveGoalSubagent(integratingSubagent);
    await recordControllerEvent(runtime, node.goalId, "integration.started", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        branch: subagent.branch,
        head: subagent.commitSha ?? subagent.integrationSourceHead,
    }, tickStartedAt);
    const integration = await options.integrator({
        goalId: node.goalId,
        node: integratingNode,
        subagent: integratingSubagent,
        state,
        validationSummary,
        validationSignals,
        tickStartedAt,
    });
    const integrationSummary = integration.summary ?? integration.error ?? `integration ${integration.status}`;
    const integrationPatch = buildIntegrationSubagentPatch(integratingSubagent, integration, tickStartedAt);
    if (integration.status === "complete" || integration.status === "notRequired") {
        await recordControllerEvent(runtime, node.goalId, "integration.passed", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            status: integration.status,
            summary: integrationSummary,
            sourceHead: integration.sourceHead,
            integrationCommitSha: integration.integrationCommitSha,
            signals: integration.validationSignals?.length ?? 0,
        }, tickStartedAt);
        await completeValidatedSubagent(runtime, integratingNode, withSubagentPatch(integratingSubagent, {
            ...integrationPatch,
            integrationState: integration.status === "complete" ? "complete" : "not-required",
        }), result, appendSummary(validationSummary, integrationSummary));
        return;
    }
    const failedState = integration.status === "blocked" ? "blocked" : "needsFollowup";
    const failedSubagent = withSubagentPatch(integratingSubagent, {
        ...integrationPatch,
        integrationState: "failed",
        status: failedState,
    });
    if (integration.followupPrompt) {
        let followed;
        try {
            followed = await sendGoalSubagentPromptWithTimeout(runtime, options, options.adapter, failedSubagent, integration.followupPrompt, tickStartedAt);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await degradePromptDispatchFailure(runtime, integratingNode, failedSubagent, result, tickStartedAt, appendSummary(validationSummary, `integration follow-up dispatch failed: ${errorMessage}`) ?? `integration follow-up dispatch failed: ${errorMessage}`, error);
            return;
        }
        const runningSubagent = withSubagentPatch(followed, {
            status: "running",
            integrationState: "failed",
            integrationStatus: integrationSummary,
            integrationError: integration.error ?? integrationSummary,
        });
        const runningNode = withNodePatch(integratingNode, { status: "running", lifecyclePhase: "runnerActive", lastValidationSummary: appendSummary(validationSummary, `integration follow-up required: ${integrationSummary}`) });
        await runtime.saveGoalSubagent(runningSubagent);
        await runtime.saveGoalDagNode(runningNode);
        await recordControllerEvent(runtime, node.goalId, "integration.followup", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            summary: integrationSummary,
            error: integration.error,
        }, tickStartedAt);
        result.followups.push(runningSubagent);
        return;
    }
    const blockedNode = withNodePatch(integratingNode, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: appendSummary(validationSummary, `integration failed: ${integrationSummary}`) });
    const blockedSubagent = withSubagentPatch(failedSubagent, { status: "blocked" });
    await runtime.saveGoalDagNode(blockedNode);
    await runtime.saveGoalSubagent(blockedSubagent);
    await recordControllerEvent(runtime, node.goalId, integration.status === "blocked" ? "integration.blocked" : "integration.failed", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        summary: integrationSummary,
        error: integration.error,
        signals: integration.validationSignals?.length ?? 0,
    }, tickStartedAt);
    result.blocked.push(blockedNode);
}
async function completeValidatedSubagent(runtime, node, subagent, result, validationSummary, subagentPatch = {}) {
    const completedNode = withNodePatch(node, { status: "complete", lifecyclePhase: "terminal", lastValidationSummary: validationSummary });
    const completedSubagent = withSubagentPatch(subagent, { ...subagentPatch, status: "complete" });
    await runtime.saveGoalDagNode(completedNode);
    await runtime.saveGoalSubagent(completedSubagent);
    await recordControllerEvent(runtime, node.goalId, "node.complete", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        summary: validationSummary,
        integrationState: completedSubagent.integrationState,
    }, completedNode.updatedAt);
    result.completed.push(completedNode);
}
function buildIntegrationSubagentPatch(subagent, integration, tickStartedAt) {
    return {
        controllerValidationResults: integration.validationSignals?.length
            ? [...(subagent.controllerValidationResults ?? []), ...integration.validationSignals]
            : subagent.controllerValidationResults,
        integrationSourceBranch: integration.sourceBranch ?? subagent.branch,
        integrationSourceRef: integration.sourceRef ?? subagent.ref,
        integrationSourceHead: integration.sourceHead ?? subagent.commitSha,
        integrationCommitSha: integration.integrationCommitSha,
        commitSha: integration.sourceHead ?? subagent.commitSha,
        integrationCompletedAt: integration.status === "complete" || integration.status === "notRequired" ? integration.completedAt ?? tickStartedAt : undefined,
        integrationStatus: integration.summary ?? integration.error ?? `integration ${integration.status}`,
        integrationError: integration.error,
    };
}
function nodeHasDownstreamDependents(state, node) {
    return state.nodes.some((candidate) => candidate.dependencyNodeIds.includes(node.nodeId));
}
function appendSummary(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    return `${left} ${right}`;
}
async function ensureDependencyIntegrationsBeforeWorkspaceAllocation(runtime, goalId, options, state, node, tickStartedAt) {
    let integrated = false;
    for (const dependencyId of node.dependencyNodeIds) {
        const upstreamSubagent = latestSubagentForNode(state.subagents, dependencyId);
        if (!upstreamSubagent)
            return { blockReason: `dependency ${dependencyId} has no subagent record`, integrated };
        if (requiredSubagentIntegrationTerminalSuccess(upstreamSubagent))
            continue;
        if (!hasSubagentBranchOrWorkspaceEvidence(upstreamSubagent))
            continue;
        if (!options.integrator)
            return { blockReason: `dependency ${dependencyId} requires integration but no controller integrator is configured`, integrated };
        const upstreamNode = state.nodes.find((candidate) => candidate.nodeId === dependencyId);
        if (!upstreamNode)
            return { blockReason: `dependency ${dependencyId} has no node record`, integrated };
        await recordControllerEvent(runtime, goalId, "integration.dependencyStarted", {
            nodeId: upstreamNode.nodeId,
            downstreamNodeId: node.nodeId,
            subagentId: upstreamSubagent.subagentId,
            branch: upstreamSubagent.branch,
            head: upstreamSubagent.commitSha ?? upstreamSubagent.integrationSourceHead,
        }, tickStartedAt);
        let integration;
        try {
            integration = await options.integrator({
                goalId,
                node: upstreamNode,
                subagent: upstreamSubagent,
                state,
                tickStartedAt,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await runtime.saveGoalSubagent(withSubagentPatch(upstreamSubagent, {
                integrationState: "failed",
                integrationStatus: `dependency integration threw: ${message}`,
                integrationError: message,
            }));
            return { blockReason: `dependency ${dependencyId} integration threw: ${message}`, integrated };
        }
        const integrationSummary = integration.summary ?? integration.error ?? `integration ${integration.status}`;
        const integrationPatch = buildIntegrationSubagentPatch(upstreamSubagent, integration, tickStartedAt);
        if (integration.status === "complete" || integration.status === "notRequired") {
            await runtime.saveGoalSubagent(withSubagentPatch(upstreamSubagent, {
                ...integrationPatch,
                integrationState: integration.status === "complete" ? "complete" : "not-required",
            }));
            await recordControllerEvent(runtime, goalId, "integration.dependencyPassed", {
                nodeId: upstreamNode.nodeId,
                downstreamNodeId: node.nodeId,
                subagentId: upstreamSubagent.subagentId,
                status: integration.status,
                summary: integrationSummary,
                sourceHead: integration.sourceHead,
                integrationCommitSha: integration.integrationCommitSha,
                signals: integration.validationSignals?.length ?? 0,
            }, tickStartedAt);
            integrated = true;
            continue;
        }
        await runtime.saveGoalSubagent(withSubagentPatch(upstreamSubagent, {
            ...integrationPatch,
            integrationState: "failed",
        }));
        await recordControllerEvent(runtime, goalId, "integration.dependencyFailed", {
            nodeId: upstreamNode.nodeId,
            downstreamNodeId: node.nodeId,
            subagentId: upstreamSubagent.subagentId,
            status: integration.status,
            summary: integrationSummary,
            error: integration.error,
            signals: integration.validationSignals?.length ?? 0,
        }, tickStartedAt);
        return { blockReason: `dependency ${dependencyId} integration failed: ${integrationSummary}`, integrated };
    }
    return { integrated };
}
async function startReadyNodes(runtime, goalId, options, result, tickStartedAt) {
    let state = await runtime.getGoalOrchestrationState(goalId);
    const queue = await runtime.getGoalDagReadyQueue(goalId, options.schedulingPolicy);
    result.ready = queue.ready;
    result.queueBlocked = queue.blocked;
    const propagatedTerminalBlocks = await blockNodesWithTerminalDependencyBlockers(runtime, goalId, state, queue.blocked, result, tickStartedAt);
    if (propagatedTerminalBlocks > 0)
        state = await runtime.getGoalOrchestrationState(goalId);
    const maxStarts = options.maxStartsPerTick ?? queue.ready.length;
    let started = 0;
    for (const node of queue.ready) {
        if (started >= maxStarts)
            break;
        if (hasNonTerminalSubagentForNode(state.subagents, node.nodeId))
            continue;
        const upstreamIntegration = await ensureDependencyIntegrationsBeforeWorkspaceAllocation(runtime, goalId, options, state, node, tickStartedAt);
        if (upstreamIntegration.integrated)
            state = await runtime.getGoalOrchestrationState(goalId);
        if (upstreamIntegration.blockReason) {
            const blockedNode = withNodePatch(node, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: upstreamIntegration.blockReason });
            await runtime.saveGoalDagNode(blockedNode);
            await recordControllerEvent(runtime, goalId, "node.upstreamIntegrationBlocked", {
                nodeId: node.nodeId,
                summary: upstreamIntegration.blockReason,
            }, tickStartedAt);
            result.blocked.push(blockedNode);
            continue;
        }
        let lifecycleNode = withGoalDagNodeLifecyclePhase(node, "acceptanceDefined", { status: "ready", now: tickStartedAt });
        await runtime.saveGoalDagNode(lifecycleNode);
        lifecycleNode = withGoalDagNodeLifecyclePhase(lifecycleNode, "resourcesCreating", { status: "running", now: tickStartedAt });
        await runtime.saveGoalDagNode(lifecycleNode);
        let allocation;
        try {
            allocation = await options.workspaceAllocator?.({ goalId, node: lifecycleNode, state, adapterId: options.adapter.adapterId, tickStartedAt });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const summary = `workspace allocation failed: ${errorMessage}`;
            const blockedNode = withNodePatch(lifecycleNode, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: summary, updatedAt: tickStartedAt });
            await runtime.saveGoalDagNode(blockedNode);
            await recordControllerEvent(runtime, goalId, "workspaceAllocation.failed", {
                nodeId: node.nodeId,
                summary,
                error: errorMessage,
            }, tickStartedAt);
            result.blocked.push(blockedNode);
            continue;
        }
        const preparedResources = {
            subagentId: allocation?.subagentId,
            adapterId: options.adapter.adapterId,
            workspacePath: allocation?.cwd,
            branch: allocation?.branch,
            ref: allocation?.ref,
            modelArg: metadataString(allocation?.metadata, "modelArg") ?? metadataString(options.metadata, "modelArg") ?? node.modelArg,
            modelScenario: metadataString(allocation?.metadata, "modelScenario") ?? metadataString(options.metadata, "modelScenario") ?? node.modelScenario,
            modelClass: metadataString(allocation?.metadata, "modelClass") ?? metadataString(options.metadata, "modelClass") ?? node.modelClass,
            modelResolution: metadataModelResolution(allocation?.metadata) ?? metadataModelResolution(options.metadata) ?? node.modelResolution,
            thinkingLevel: metadataString(allocation?.metadata, "thinkingLevel") ?? metadataString(options.metadata, "thinkingLevel") ?? node.thinkingLevel,
            metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}) },
            createdAt: tickStartedAt,
            updatedAt: tickStartedAt,
        };
        lifecycleNode = attachPreparedResourcesToNode(lifecycleNode, preparedResources, { phase: "resourcesReady", now: tickStartedAt });
        await runtime.saveGoalDagNode(lifecycleNode);
        lifecycleNode = withGoalDagNodeLifecyclePhase(lifecycleNode, "runnerStarting", { status: "running", now: tickStartedAt });
        await runtime.saveGoalDagNode(lifecycleNode);
        const startOptions = {
            subagentId: allocation?.subagentId,
            cwd: allocation?.cwd,
            branch: allocation?.branch,
            ref: allocation?.ref,
            systemPrompt: allocation?.systemPrompt ?? options.systemPrompt,
            initialPrompt: allocation?.initialPrompt ?? options.renderInitialPrompt?.({ goalId, node, state }) ?? renderDefaultInitialPrompt(node),
            preparedResources,
            metadata: { ...(options.metadata ?? {}), ...(allocation?.metadata ?? {}) },
            now: tickStartedAt,
            thinkingLevel: preparedResources.thinkingLevel ?? node.thinkingLevel,
        };
        let subagent;
        try {
            subagent = await startGoalSubagentWithTimeout(runtime, options, options.adapter, lifecycleNode, startOptions, tickStartedAt);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (error instanceof ControllerActionTimeoutError) {
                const pendingNode = withNodePatch(lifecycleNode, {
                    status: "running",
                    lifecyclePhase: "runnerStarting",
                    lastValidationSummary: `runner launch timed out; stale runner-start recovery can retry after threshold: ${errorMessage}`,
                    updatedAt: tickStartedAt,
                });
                await runtime.saveGoalDagNode(pendingNode);
                await recordControllerEvent(runtime, goalId, "node.runnerLaunchTimedOut", {
                    nodeId: node.nodeId,
                    subagentId: startOptions.subagentId,
                    summary: pendingNode.lastValidationSummary,
                }, tickStartedAt);
                continue;
            }
            const summary = isProviderLimitError(errorMessage)
                ? quotaBlockedSummary(errorMessage)
                : unhandledScenarioBlockedSummary(`runner launch failed: ${errorMessage}`);
            const blockedNode = withNodePatch(lifecycleNode, { status: "blocked", lifecyclePhase: "terminal", lastValidationSummary: summary, updatedAt: tickStartedAt });
            await runtime.saveGoalDagNode(blockedNode);
            await recordControllerEvent(runtime, goalId, "node.runnerLaunchFailed", {
                nodeId: node.nodeId,
                summary,
                error: errorMessage,
            }, tickStartedAt);
            result.blocked.push(blockedNode);
            continue;
        }
        await recordControllerEvent(runtime, goalId, "node.started", {
            nodeId: node.nodeId,
            subagentId: subagent.subagentId,
            branch: subagent.branch,
            workspacePath: subagent.workspacePath,
            model: startOptions.metadata?.modelArg,
            scenario: startOptions.metadata?.modelScenario,
        }, tickStartedAt);
        result.started.push(subagent);
        started += 1;
    }
}
const TERMINAL_DEPENDENCY_BLOCKER_STATUSES = new Set(["blocked", "blockedTerminal", "failed", "superseded"]);
async function blockNodesWithTerminalDependencyBlockers(runtime, goalId, state, queueBlocked, result, tickStartedAt) {
    const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node]));
    const terminalBlockedNodeIds = new Set(state.nodes
        .filter((node) => TERMINAL_DEPENDENCY_BLOCKER_STATUSES.has(node.status))
        .map((node) => node.nodeId));
    const propagatedSummaries = new Map();
    let changed = 0;
    for (const { node } of queueBlocked) {
        if (TERMINAL_DEPENDENCY_BLOCKER_STATUSES.has(node.status))
            continue;
        const blockingDependencyIds = node.dependencyNodeIds.filter((dependencyId) => terminalBlockedNodeIds.has(dependencyId));
        if (blockingDependencyIds.length === 0)
            continue;
        const dependencySummary = blockingDependencyIds.map((dependencyId) => {
            const dependency = nodesById.get(dependencyId);
            const status = dependency?.status ?? "blocked";
            const detail = propagatedSummaries.get(dependencyId) ?? dependency?.lastValidationSummary;
            return detail ? `dependency ${dependencyId} is ${status}: ${detail}` : `dependency ${dependencyId} is ${status}`;
        }).join("; ");
        const summary = `dependency blocked: ${dependencySummary}`;
        const blockedNode = withNodePatch(node, {
            status: "blocked",
            lifecyclePhase: "terminal",
            lastValidationSummary: summary,
            updatedAt: tickStartedAt,
        });
        await runtime.saveGoalDagNode(blockedNode);
        await recordControllerEvent(runtime, goalId, "node.dependencyBlocked", {
            nodeId: node.nodeId,
            dependencyNodeIds: blockingDependencyIds,
            summary,
        }, tickStartedAt);
        result.blocked.push(blockedNode);
        nodesById.set(blockedNode.nodeId, blockedNode);
        terminalBlockedNodeIds.add(blockedNode.nodeId);
        propagatedSummaries.set(blockedNode.nodeId, summary);
        changed += 1;
    }
    return changed;
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
function latestSubagentForNode(subagents, nodeId) {
    let latest;
    for (const subagent of subagents) {
        if (subagent.nodeId !== nodeId)
            continue;
        if (!latest || subagent.updatedAt > latest.updatedAt)
            latest = subagent;
    }
    return latest;
}
function hasNonTerminalSubagentForNode(subagents, nodeId) {
    return subagents.some((subagent) => subagent.nodeId === nodeId && NON_TERMINAL_SUBAGENT_STATUSES.has(subagent.status));
}
function lifecyclePhaseForObservation(observation) {
    switch (observation.kind) {
        case "runnerStarting":
            return "runnerStarting";
        case "running":
        case "idle":
            return "runnerActive";
        case "selfReportedComplete":
        case "selfReportedBlocked":
        case "protocolViolation":
        case "runnerError":
        case "runnerLost":
        case "stopped":
            return "controllerJudging";
    }
}
function observationFromSubagentStatus(adapterId, subagent, kind, at) {
    return {
        adapterId,
        kind,
        at,
        summary: subagent.selfReportedResult,
        error: subagent.integrationStatus,
        evidence: { status: subagent.status, retryCount: subagent.retryCount },
    };
}
function controllerEventForSyncedSubagent(subagent) {
    switch (subagent.status) {
        case "selfReportedComplete":
            return "subagent.result";
        case "blocked":
            return "subagent.blocked";
        case "needsFollowup":
            return "subagent.needsFollowup";
        case "failed":
            return "subagent.failed";
        default:
            return "subagent.synced";
    }
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
function repeatedValidationFailure(subagent, validation) {
    const signature = validationFailureSignature(validation);
    if (!signature)
        return { count: 0 };
    const previous = (subagent.controllerValidationResults ?? []).filter((item) => normalizeValidationFailureSignature(item) === signature).length;
    return { signature, count: previous + 1 };
}
function validationFailureSignature(validation) {
    return normalizeValidationFailureSignature(validation.summary) ?? (validation.validationSignals ?? []).map(normalizeValidationFailureSignature).find(Boolean);
}
function normalizeValidationFailureSignature(value) {
    const normalized = value?.replace(/\s+/g, " ").trim();
    return normalized ? normalized : undefined;
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
        "",
        ...renderExecutorGuardrailLines(node),
    ].filter((line) => Boolean(line)).join("\n");
}
function resolveNow(now) {
    return typeof now === "function" ? now() : now ?? new Date();
}
function toIso(value) {
    return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
async function startGoalSubagentWithTimeout(runtime, options, adapter, node, startOptions, tickStartedAt) {
    const timeoutMs = options.subagentRunnerLaunchTimeoutMs ?? DEFAULT_SUBAGENT_RUNNER_LAUNCH_TIMEOUT_MS;
    const expectedSubagentId = startOptions.subagentId ?? node.preparedResources?.subagentId ?? "auto";
    const actionAttempt = buildControllerActionAttempt("runnerLaunch", {
        goalId: node.goalId,
        nodeId: node.nodeId,
        subagentId: expectedSubagentId,
    }, tickStartedAt, timeoutMs > 0 ? timeoutMs : undefined, {
        adapterId: adapter.adapterId,
        workspacePath: startOptions.cwd,
        branch: startOptions.branch,
        ref: startOptions.ref,
    });
    await recordControllerEvent(runtime, node.goalId, "recovery.actionStarted", {
        nodeId: node.nodeId,
        subagentId: expectedSubagentId,
        actionId: actionAttempt.actionId,
        actionKind: actionAttempt.actionKind,
        deadlineAt: actionAttempt.deadlineAt,
        workspacePath: startOptions.cwd,
        branch: startOptions.branch,
    }, tickStartedAt);
    const launch = runtime.startGoalSubagent(adapter, node, {
        ...startOptions,
        metadata: { ...(startOptions.metadata ?? {}), controllerActionAttempt: actionAttempt },
    });
    try {
        const started = timeoutMs <= 0
            ? await launch
            : await promiseWithTimeout(launch, timeoutMs, `subagent runner launch timed out after ${timeoutMs}ms for ${expectedSubagentId}`, actionAttempt);
        const succeededAttempt = {
            ...actionAttempt,
            status: "succeeded",
            evidence: { ...(actionAttempt.evidence ?? {}), subagentId: started.subagentId, sessionId: started.sessionId },
        };
        const patched = withSubagentPatch(started, { lastActionAttempt: succeededAttempt });
        await runtime.saveGoalSubagent(patched);
        await recordControllerEvent(runtime, node.goalId, "recovery.actionSucceeded", {
            nodeId: node.nodeId,
            subagentId: started.subagentId,
            actionId: succeededAttempt.actionId,
            actionKind: succeededAttempt.actionKind,
        }, tickStartedAt);
        return patched;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const timeout = error instanceof ControllerActionTimeoutError;
        const failedAttempt = {
            ...actionAttempt,
            status: timeout ? "timedOut" : "failed",
            error: errorMessage,
        };
        await recordControllerEvent(runtime, node.goalId, timeout ? "recovery.actionTimedOut" : "recovery.actionFailed", {
            nodeId: node.nodeId,
            subagentId: expectedSubagentId,
            actionId: failedAttempt.actionId,
            actionKind: failedAttempt.actionKind,
            deadlineAt: failedAttempt.deadlineAt,
            error: errorMessage,
        }, tickStartedAt);
        throw error;
    }
}
async function sendGoalSubagentPromptWithTimeout(runtime, options, adapter, subagent, prompt, tickStartedAt) {
    const timeoutMs = options.subagentPromptDispatchTimeoutMs ?? DEFAULT_SUBAGENT_PROMPT_DISPATCH_TIMEOUT_MS;
    const actionAttempt = buildControllerActionAttempt("promptDispatch", subagent, tickStartedAt, timeoutMs > 0 ? timeoutMs : undefined, {
        promptChars: prompt.length,
        adapterId: adapter.adapterId,
    });
    await recordControllerEvent(runtime, subagent.goalId, "recovery.actionStarted", {
        nodeId: subagent.nodeId,
        subagentId: subagent.subagentId,
        actionId: actionAttempt.actionId,
        actionKind: actionAttempt.actionKind,
        deadlineAt: actionAttempt.deadlineAt,
        promptChars: prompt.length,
    }, tickStartedAt);
    const metadata = { ...(options.metadata ?? {}), controllerActionAttempt: actionAttempt };
    const dispatch = runtime.sendGoalSubagentPrompt(adapter, subagent, prompt, {
        metadata,
        now: tickStartedAt,
    });
    try {
        const updated = timeoutMs <= 0
            ? await dispatch
            : await promiseWithTimeout(dispatch, timeoutMs, `subagent prompt dispatch timed out after ${timeoutMs}ms for ${subagent.subagentId}`, actionAttempt);
        const succeededAttempt = { ...actionAttempt, status: "succeeded" };
        await recordControllerEvent(runtime, subagent.goalId, "recovery.actionSucceeded", {
            nodeId: subagent.nodeId,
            subagentId: subagent.subagentId,
            actionId: succeededAttempt.actionId,
            actionKind: succeededAttempt.actionKind,
        }, tickStartedAt);
        return withSubagentPatch(updated, { lastActionAttempt: succeededAttempt });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const timeout = error instanceof ControllerActionTimeoutError;
        const failedAttempt = {
            ...actionAttempt,
            status: timeout ? "timedOut" : "failed",
            error: errorMessage,
        };
        await recordControllerEvent(runtime, subagent.goalId, timeout ? "recovery.actionTimedOut" : "recovery.actionFailed", {
            nodeId: subagent.nodeId,
            subagentId: subagent.subagentId,
            actionId: failedAttempt.actionId,
            actionKind: failedAttempt.actionKind,
            deadlineAt: failedAttempt.deadlineAt,
            error: errorMessage,
        }, tickStartedAt);
        throw error;
    }
}
function buildControllerActionAttempt(actionKind, target, startedAt, timeoutMs, evidence = {}) {
    const startedMs = Date.parse(startedAt);
    const deadlineAt = timeoutMs === undefined || timeoutMs <= 0 || !Number.isFinite(startedMs)
        ? undefined
        : new Date(startedMs + timeoutMs).toISOString();
    return {
        actionId: `${actionKind}-${target.goalId}-${target.subagentId}-${String(Date.parse(startedAt)).replace(/[^0-9]/g, "") || "now"}`,
        actionKind,
        startedAt,
        deadlineAt,
        status: "started",
        evidence: { nodeId: target.nodeId, ...evidence },
    };
}
async function promiseWithTimeout(promise, timeoutMs, message, actionAttempt) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new ControllerActionTimeoutError(message, actionAttempt)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
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