import type { GoalDagSchedulingPolicy } from "./dag-scheduler.js";
import { nodeRequiresSubagentIntegration, subagentIntegrationTerminalSuccess } from "./integration.js";
import type { HarnessSubagentAdapter, StartGoalSubagentOptions } from "./subagent-adapter.js";
import type { GoalDagNode, GoalOrchestrationState, GoalSubagentRecord } from "./types.js";

export interface GoalControllerRuntimePort {
  getGoalOrchestrationState(goalId: string): Promise<GoalOrchestrationState>;
  getGoalDagReadyQueue(goalId: string, policy?: GoalDagSchedulingPolicy): Promise<{ ready: GoalDagNode[]; blocked: Array<{ node: GoalDagNode; reasons: string[] }> }>;
  saveGoalDagNode(node: GoalDagNode): Promise<void>;
  saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void>;
  startGoalSubagent(adapter: HarnessSubagentAdapter, node: GoalDagNode, options: StartGoalSubagentOptions): Promise<GoalSubagentRecord>;
  sendGoalSubagentPrompt(
    adapter: HarnessSubagentAdapter,
    subagent: GoalSubagentRecord,
    prompt: string,
    options?: { metadata?: Record<string, unknown>; now?: Date | string },
  ): Promise<GoalSubagentRecord>;
  syncGoalSubagent(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord): Promise<GoalSubagentRecord>;
}

export interface GoalControllerWorkspaceAllocation {
  subagentId?: string;
  cwd?: string;
  branch?: string;
  ref?: string;
  systemPrompt?: string;
  initialPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface GoalControllerWorkspaceAllocationRequest {
  goalId: string;
  node: GoalDagNode;
  state: GoalOrchestrationState;
  adapterId: string;
  tickStartedAt: string;
}

export type GoalControllerWorkspaceAllocator = (
  request: GoalControllerWorkspaceAllocationRequest,
) => Promise<GoalControllerWorkspaceAllocation | undefined> | GoalControllerWorkspaceAllocation | undefined;

export interface GoalControllerValidationRequest {
  goalId: string;
  node: GoalDagNode;
  subagent: GoalSubagentRecord;
  state: GoalOrchestrationState;
  tickStartedAt: string;
}

export type GoalControllerValidationStatus = "passed" | "failed" | "blocked";

export interface GoalControllerValidationResult {
  status: GoalControllerValidationStatus;
  summary?: string;
  followupPrompt?: string;
  validationSignals?: string[];
}

export type GoalControllerValidator = (
  request: GoalControllerValidationRequest,
) => Promise<GoalControllerValidationResult> | GoalControllerValidationResult;

export interface GoalControllerIntegrationRequest {
  goalId: string;
  node: GoalDagNode;
  subagent: GoalSubagentRecord;
  state: GoalOrchestrationState;
  validationSummary?: string;
  validationSignals?: string[];
  tickStartedAt: string;
}

export type GoalControllerIntegrationStatus = "complete" | "notRequired" | "failed" | "blocked";

export interface GoalControllerIntegrationResult {
  status: GoalControllerIntegrationStatus;
  summary?: string;
  followupPrompt?: string;
  validationSignals?: string[];
  sourceBranch?: string;
  sourceRef?: string;
  sourceHead?: string;
  integrationCommitSha?: string;
  error?: string;
  completedAt?: string;
}

export type GoalControllerIntegrator = (
  request: GoalControllerIntegrationRequest,
) => Promise<GoalControllerIntegrationResult> | GoalControllerIntegrationResult;

export interface GoalControllerInitialPromptRequest {
  goalId: string;
  node: GoalDagNode;
  state: GoalOrchestrationState;
}

export interface GoalControllerTickOptions {
  adapter: HarnessSubagentAdapter;
  schedulingPolicy?: GoalDagSchedulingPolicy;
  workspaceAllocator?: GoalControllerWorkspaceAllocator;
  validator?: GoalControllerValidator;
  /** Integrates repository-changing subagent branches before node completion. */
  integrator?: GoalControllerIntegrator;
  renderInitialPrompt?: (request: GoalControllerInitialPromptRequest) => string;
  maxStartsPerTick?: number;
  /** Maximum auto-retry attempts for transient subagent failures (default 2). */
  maxAutoRetries?: number;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  now?: Date | string | (() => Date | string);
}

export interface GoalControllerTickResult {
  goalId: string;
  started: GoalSubagentRecord[];
  synced: GoalSubagentRecord[];
  validating: GoalDagNode[];
  completed: GoalDagNode[];
  followups: GoalSubagentRecord[];
  blocked: GoalDagNode[];
  failed: GoalDagNode[];
  ready: GoalDagNode[];
  queueBlocked: Array<{ node: GoalDagNode; reasons: string[] }>;
  changed: boolean;
}

export interface GoalControllerLoopOptions extends GoalControllerTickOptions {
  maxTicks?: number;
  intervalMs?: number;
  stopWhenIdle?: boolean;
  signal?: AbortSignal;
}

export interface GoalControllerLoopResult {
  goalId: string;
  ticks: GoalControllerTickResult[];
}

const SYNCABLE_SUBAGENT_STATUSES = new Set<GoalSubagentRecord["status"]>(["sessionStarted", "running", "idle"]);
const NON_TERMINAL_SUBAGENT_STATUSES = new Set<GoalSubagentRecord["status"]>([
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

const CONTEXT_FALLBACK_MODELS: Record<string, string> = {
  "openai-codex/gpt-5.3-codex-spark": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-pro",
  "minimax/MiniMax-M3": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro", // already largest, no fallback
  "openai-codex/gpt-5.5": "deepseek/deepseek-v4-pro",
};

function isTransientError(message: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isContextExceededError(message: string): boolean {
  return CONTEXT_EXCEEDED_PATTERNS.some((pattern) => pattern.test(message));
}

function isProviderLimitError(message: string): boolean {
  return PROVIDER_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function contextFallbackModel(currentModel: string | undefined): string | undefined {
  if (!currentModel) return undefined;
  const fallback = CONTEXT_FALLBACK_MODELS[currentModel];
  // Don't fallback if already on the largest model
  if (fallback === currentModel) return undefined;
  return fallback;
}

function buildRecoveryPrompt(node: GoalDagNode, errorMessage: string, retryCount: number, maxRetries: number): string {
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

function buildUnhandledScenarioRecoveryPrompt(node: GoalDagNode, errorMessage: string, retryCount: number, maxRetries: number): string {
  return [
    `[SYSTEM RECOVERY: UNHANDLED_SCENARIO] The controller observed an unclassified error but is preserving this session instead of abandoning it.`,
    `Error: ${errorMessage}`,
    `Diagnose the situation from the existing transcript/workspace. If you can remediate, continue the node objective: "${node.objective}"`,
    `If this is a runtime/controller bug or requires developer input, report SUBAGENT_BLOCKED with a concise reproduction and proposed handler.`,
    `Do not start over unless current workspace inspection proves prior work is unusable.`,
    `In-place diagnostic recovery ${retryCount + 1}/${maxRetries}.`,
  ].join("\n");
}

function quotaBlockedSummary(errorMessage: string): string {
  return `blocked: provider/model quota or billing limit reached; configure credentials, quota, or a fallback model before continuing. Error: ${errorMessage}`;
}

function unhandledScenarioBlockedSummary(errorMessage: string): string {
  return `blocked: unhandled subagent error after in-place recovery attempts; add a controller recovery handler or provide developer guidance. Error: ${errorMessage}`;
}

function buildContextUpgradePrompt(node: GoalDagNode, oldModel: string, newModel: string): string {
  return [
    `[SYSTEM RECOVERY] The previous model (${oldModel}) ran out of context window.`,
    `You have been restarted with a larger-context model: ${newModel}.`,
    `Please resume your work on: "${node.objective}"`,
    `Report with SUBAGENT_RESULT: <summary> when done, or SUBAGENT_BLOCKED: <reason> if blocked.`,
  ].join("\n");
}

const OUTCOME_MARKER_FOLLOWUP_TAG = "[SYSTEM FOLLOW-UP: EXPLICIT_OUTCOME_MARKER]";

function buildSubagentFollowupPrompt(node: GoalDagNode, subagent: GoalSubagentRecord): string {
  return isStaleSubagentSession(subagent)
    ? buildStaleSubagentContinuationPrompt(node, subagent)
    : buildExplicitOutcomeMarkerPrompt(node, subagent);
}

function buildExplicitOutcomeMarkerPrompt(node: GoalDagNode, subagent: GoalSubagentRecord): string {
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

function isStaleSubagentSession(subagent: GoalSubagentRecord): boolean {
  return /^stale-subagent-session:/i.test(subagent.integrationStatus ?? "");
}

function buildStaleSubagentContinuationPrompt(node: GoalDagNode, subagent: GoalSubagentRecord): string {
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

function truncateForPrompt(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

async function tryAutoRecoverFailedNode(
  runtime: GoalControllerRuntimePort,
  adapter: HarnessSubagentAdapter,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  state: GoalOrchestrationState,
  result: GoalControllerTickResult,
  options: GoalControllerTickOptions,
  tickStartedAt: string,
  observedError?: string,
): Promise<boolean> {
  const errorMessage = observedError ?? subagent.integrationStatus ?? subagent.selfReportedResult ?? "unknown error";
  const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
  const retryCount = subagent.retryCount ?? 0;

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
    result.blocked.push(blockedNode);
    result.synced.push(blockedSubagent);
    return true;
  }

  const isContext = isContextExceededError(errorMessage);
  const oldModel = node.modelArg ?? subagent.workspacePath ?? "unknown";

  if (isContext) {
    const fallback = contextFallbackModel(node.modelArg);
    if (!fallback) {
      const summary = unhandledScenarioBlockedSummary(errorMessage);
      const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
      const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
      await runtime.saveGoalSubagent(blockedSubagent);
      await runtime.saveGoalDagNode(blockedNode);
      result.blocked.push(blockedNode);
      result.synced.push(blockedSubagent);
      return true;
    }
    await runtime.saveGoalDagNode(withNodePatch(node, {
      status: "running",
      modelArg: fallback,
      thinkingLevel: "high",
      lastValidationSummary: `last-resort context fallback from ${node.modelArg ?? "unknown"} to ${fallback}`,
      updatedAt: tickStartedAt,
    }));
    node = { ...node, modelArg: fallback, thinkingLevel: "high" };

    const recoveryPrompt = buildContextUpgradePrompt(node, oldModel, fallback);
    const allocation = await options.workspaceAllocator?.({ goalId: subagent.goalId, node, state, adapterId: adapter.adapterId, tickStartedAt });
    const startOptions: StartGoalSubagentOptions = {
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
      status: "blocked",
      integrationStatus: `context exceeded with ${oldModel}; work transferred to last-resort fallback model ${fallback}`,
      retryCount: retryCount + 1,
      updatedAt: tickStartedAt,
    }));
    const newSubagent = await runtime.startGoalSubagent(adapter, node, startOptions);
    result.started.push(newSubagent);
    return true;
  }

  const isTransient = isTransientError(errorMessage);
  if (retryCount >= maxRetries) {
    const summary = unhandledScenarioBlockedSummary(errorMessage);
    const blockedSubagent = withSubagentPatch(subagent, { status: "blocked", integrationStatus: summary, retryCount, updatedAt: tickStartedAt });
    const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: summary, updatedAt: tickStartedAt });
    await runtime.saveGoalSubagent(blockedSubagent);
    await runtime.saveGoalDagNode(blockedNode);
    result.blocked.push(blockedNode);
    result.synced.push(blockedSubagent);
    return true;
  }

  const recoveryPrompt = isTransient
    ? buildRecoveryPrompt(node, errorMessage, retryCount, maxRetries)
    : buildUnhandledScenarioRecoveryPrompt(node, errorMessage, retryCount, maxRetries);
  const recovered = await runtime.sendGoalSubagentPrompt(adapter, subagent, recoveryPrompt, {
    metadata: options.metadata,
    now: tickStartedAt,
  });
  const status = isTransient
    ? `in-place recovery ${retryCount + 1}/${maxRetries}: ${errorMessage}`
    : `unhandled-scenario recovery ${retryCount + 1}/${maxRetries}: ${errorMessage}`;
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
  result.followups.push(runningSubagent);
  result.synced.push(runningSubagent);
  return true;
}

export async function runGoalControllerTick(
  runtime: GoalControllerRuntimePort,
  goalId: string,
  options: GoalControllerTickOptions,
): Promise<GoalControllerTickResult> {
  const tickStartedAt = toIso(resolveNow(options.now));
  const result: GoalControllerTickResult = {
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

export async function runGoalControllerLoop(
  runtime: GoalControllerRuntimePort,
  goalId: string,
  options: GoalControllerLoopOptions,
): Promise<GoalControllerLoopResult> {
  const maxTicks = options.maxTicks ?? 1;
  const intervalMs = options.intervalMs ?? 1_000;
  const stopWhenIdle = options.stopWhenIdle ?? true;
  const ticks: GoalControllerTickResult[] = [];

  for (let index = 0; index < maxTicks; index += 1) {
    if (options.signal?.aborted) break;
    const tick = await runGoalControllerTick(runtime, goalId, options);
    ticks.push(tick);
    if (stopWhenIdle && !tick.changed && tick.ready.length === 0) break;
    if (index < maxTicks - 1) await sleep(intervalMs, options.signal);
  }

  return { goalId, ticks };
}

async function syncSubagents(
  runtime: GoalControllerRuntimePort,
  adapter: HarnessSubagentAdapter,
  state: GoalOrchestrationState,
  result: GoalControllerTickResult,
  options: GoalControllerTickOptions,
  tickStartedAt: string,
): Promise<void> {
  for (const subagent of state.subagents) {
    if (subagent.harnessAdapterId !== adapter.adapterId) continue;
    if (!SYNCABLE_SUBAGENT_STATUSES.has(subagent.status)) continue;
    try {
      const updated = await runtime.syncGoalSubagent(adapter, subagent);
      if (subagentChanged(subagent, updated)) result.synced.push(updated);
    } catch (error) {
      if (isTransientStoreLockError(error)) continue;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const node = state.nodes.find((item) => item.nodeId === subagent.nodeId);
      if (node) {
        try {
          const recovered = await tryAutoRecoverFailedNode(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage);
          if (recovered) continue;
        } catch (retryError) {
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
      const failedNode = withNodePatch(node ?? { nodeId: subagent.nodeId } as GoalDagNode, { status: "failed", lastValidationSummary: failed.integrationStatus });
      await runtime.saveGoalDagNode(failedNode);
      result.failed.push(failedNode);
      result.synced.push(failed);
    }
  }
}

async function reconcileSubagentOutcomes(
  runtime: GoalControllerRuntimePort,
  goalId: string,
  options: GoalControllerTickOptions,
  result: GoalControllerTickResult,
  tickStartedAt: string,
): Promise<void> {
  const state = await runtime.getGoalOrchestrationState(goalId);
  const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node]));
  for (const subagent of latestSubagentPerNode(state.subagents)) {
    const node = nodesById.get(subagent.nodeId);
    if (!node) continue;

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
        if (recovered) continue;
      } catch (retryError) {
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

async function validateOrHold(
  runtime: GoalControllerRuntimePort,
  options: GoalControllerTickOptions,
  state: GoalOrchestrationState,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  result: GoalControllerTickResult,
  tickStartedAt: string,
): Promise<void> {
  const validatingNode = withNodePatch(node, { status: "controllerValidating" });
  const validatingSubagent = withSubagentPatch(subagent, { status: "controllerValidating" });
  await runtime.saveGoalDagNode(validatingNode);
  await runtime.saveGoalSubagent(validatingSubagent);
  result.validating.push(validatingNode);

  if (!options.validator) return;

  const validation = await options.validator({ goalId: node.goalId, node: validatingNode, subagent: validatingSubagent, state, tickStartedAt });
  const validationSummary = validation.summary ?? validation.validationSignals?.join("; ");
  const validationResults = appendValidationResults(validatingSubagent, validation);

  if (validation.status === "passed") {
    await integrateOrCompleteValidatedSubagent(runtime, options, state, validatingNode, validationResults, result, tickStartedAt, validationSummary, validation.validationSignals);
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

async function integrateOrCompleteValidatedSubagent(
  runtime: GoalControllerRuntimePort,
  options: GoalControllerTickOptions,
  state: GoalOrchestrationState,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  result: GoalControllerTickResult,
  tickStartedAt: string,
  validationSummary?: string,
  validationSignals?: string[],
): Promise<void> {
  if (!nodeRequiresSubagentIntegration(node, subagent)) {
    await completeValidatedSubagent(runtime, node, subagent, result, validationSummary, { integrationState: "not-required", integrationStatus: "integration not required" });
    return;
  }

  if (subagentIntegrationTerminalSuccess(subagent)) {
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
    result.blocked.push(blockedNode);
    return;
  }

  const integratingSubagent = withSubagentPatch(subagent, {
    integrationState: "integrating",
    integrationStatus: "integrating subagent branch into controller workspace",
  });
  await runtime.saveGoalSubagent(integratingSubagent);

  const integration = await options.integrator({
    goalId: node.goalId,
    node,
    subagent: integratingSubagent,
    state,
    validationSummary,
    validationSignals,
    tickStartedAt,
  });
  const integrationSummary = integration.summary ?? integration.error ?? `integration ${integration.status}`;
  const integrationPatch: Partial<GoalSubagentRecord> = {
    integrationSourceBranch: integration.sourceBranch ?? integratingSubagent.branch,
    integrationSourceRef: integration.sourceRef ?? integratingSubagent.ref,
    integrationSourceHead: integration.sourceHead ?? integratingSubagent.commitSha,
    integrationCommitSha: integration.integrationCommitSha,
    commitSha: integration.sourceHead ?? integratingSubagent.commitSha,
    integrationCompletedAt: integration.status === "complete" || integration.status === "notRequired" ? integration.completedAt ?? tickStartedAt : undefined,
    integrationStatus: integrationSummary,
    integrationError: integration.error,
  };

  if (integration.status === "complete" || integration.status === "notRequired") {
    await completeValidatedSubagent(runtime, node, withSubagentPatch(integratingSubagent, {
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
    const followed = await runtime.sendGoalSubagentPrompt(options.adapter, failedSubagent, integration.followupPrompt, {
      metadata: options.metadata,
      now: tickStartedAt,
    });
    const runningSubagent = withSubagentPatch(followed, {
      status: "running",
      integrationState: "failed",
      integrationStatus: integrationSummary,
      integrationError: integration.error ?? integrationSummary,
    });
    const runningNode = withNodePatch(node, { status: "running", lastValidationSummary: appendSummary(validationSummary, `integration follow-up required: ${integrationSummary}`) });
    await runtime.saveGoalSubagent(runningSubagent);
    await runtime.saveGoalDagNode(runningNode);
    result.followups.push(runningSubagent);
    return;
  }

  const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: appendSummary(validationSummary, `integration failed: ${integrationSummary}`) });
  const blockedSubagent = withSubagentPatch(failedSubagent, { status: "blocked" });
  await runtime.saveGoalDagNode(blockedNode);
  await runtime.saveGoalSubagent(blockedSubagent);
  result.blocked.push(blockedNode);
}

async function completeValidatedSubagent(
  runtime: GoalControllerRuntimePort,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  result: GoalControllerTickResult,
  validationSummary?: string,
  subagentPatch: Partial<GoalSubagentRecord> = {},
): Promise<void> {
  const completedNode = withNodePatch(node, { status: "complete", lastValidationSummary: validationSummary });
  const completedSubagent = withSubagentPatch(subagent, { ...subagentPatch, status: "complete" });
  await runtime.saveGoalDagNode(completedNode);
  await runtime.saveGoalSubagent(completedSubagent);
  result.completed.push(completedNode);
}

function appendSummary(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

async function startReadyNodes(
  runtime: GoalControllerRuntimePort,
  goalId: string,
  options: GoalControllerTickOptions,
  result: GoalControllerTickResult,
  tickStartedAt: string,
): Promise<void> {
  const state = await runtime.getGoalOrchestrationState(goalId);
  const queue = await runtime.getGoalDagReadyQueue(goalId, options.schedulingPolicy);
  result.ready = queue.ready;
  result.queueBlocked = queue.blocked;
  const maxStarts = options.maxStartsPerTick ?? queue.ready.length;
  let started = 0;
  for (const node of queue.ready) {
    if (started >= maxStarts) break;
    if (hasNonTerminalSubagentForNode(state.subagents, node.nodeId)) continue;
    const allocation = await options.workspaceAllocator?.({ goalId, node, state, adapterId: options.adapter.adapterId, tickStartedAt });
    const startOptions: StartGoalSubagentOptions = {
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

function latestSubagentPerNode(subagents: GoalSubagentRecord[]): GoalSubagentRecord[] {
  const latest = new Map<string, GoalSubagentRecord>();
  for (const subagent of subagents) {
    const current = latest.get(subagent.nodeId);
    if (!current || subagent.updatedAt > current.updatedAt) latest.set(subagent.nodeId, subagent);
  }
  return [...latest.values()];
}

function hasNonTerminalSubagentForNode(subagents: GoalSubagentRecord[], nodeId: string): boolean {
  return subagents.some((subagent) => subagent.nodeId === nodeId && NON_TERMINAL_SUBAGENT_STATUSES.has(subagent.status));
}

function isTransientStoreLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function appendValidationResults(subagent: GoalSubagentRecord, validation: GoalControllerValidationResult): GoalSubagentRecord {
  const additions = [validation.summary, ...(validation.validationSignals ?? [])].filter((item): item is string => Boolean(item?.trim()));
  if (additions.length === 0) return subagent;
  return { ...subagent, controllerValidationResults: [...(subagent.controllerValidationResults ?? []), ...additions] };
}

function withNodePatch(node: GoalDagNode, patch: Partial<GoalDagNode>): GoalDagNode {
  return { ...node, ...patch, updatedAt: new Date().toISOString() };
}

function withSubagentPatch(subagent: GoalSubagentRecord, patch: Partial<GoalSubagentRecord>): GoalSubagentRecord {
  return { ...subagent, ...patch, updatedAt: new Date().toISOString(), lastActivityAt: patch.lastActivityAt ?? subagent.lastActivityAt };
}

function subagentChanged(left: GoalSubagentRecord, right: GoalSubagentRecord): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function renderDefaultInitialPrompt(node: GoalDagNode): string {
  return [
    `Implement DAG node ${node.nodeId}: ${node.objective}`,
    node.scope ? `Scope: ${node.scope}` : undefined,
    node.expectedOutputs.length ? `Expected outputs: ${node.expectedOutputs.join(", ")}` : undefined,
    node.validators.length ? `Validators: ${node.validators.join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function resolveNow(now: GoalControllerTickOptions["now"]): Date | string {
  return typeof now === "function" ? now() : now ?? new Date();
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
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
