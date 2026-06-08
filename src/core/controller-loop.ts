import type { GoalDagSchedulingPolicy } from "./dag-scheduler.js";
import { nodeRequiresSubagentIntegration, requiredSubagentIntegrationTerminalSuccess } from "./integration.js";
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
  recordControllerEvent?(goalId: string, details: Record<string, unknown>, options?: { at?: Date | string }): Promise<void>;
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

const SYNCABLE_SUBAGENT_STATUSES = new Set<GoalSubagentRecord["status"]>(["sessionStarted", "running", "idle", "blocked"]);
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
const MAX_VALIDATION_FOLLOWUPS_FOR_SAME_FAILURE = 2;
const RECOVERY_BLOCKED_LEDGER_COOLDOWN_MS = 5 * 60_000;
const recoveryBlockedLedgerCooldown = new Map<string, number>();

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

const CONTEXT_FALLBACK_MODELS: Record<string, string> = {
  "openai-codex/gpt-5.3-codex-spark": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-pro",
  "minimax/MiniMax-M3": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro", // already largest, no fallback
  "openai-codex/gpt-5.5": "deepseek/deepseek-v4-pro",
};

async function recordControllerEvent(
  runtime: GoalControllerRuntimePort,
  goalId: string,
  event: string,
  details: Record<string, unknown> = {},
  at?: Date | string,
): Promise<void> {
  if (!runtime.recordControllerEvent) return;
  if (shouldSuppressControllerEvent(goalId, event, details, at)) return;
  try {
    await runtime.recordControllerEvent(goalId, { event, ...details }, { at });
  } catch {
    // Controller history is diagnostic only; never let ledger writes disrupt orchestration.
  }
}

function shouldSuppressControllerEvent(goalId: string, event: string, details: Record<string, unknown>, at?: Date | string): boolean {
  if (event !== "recovery.blocked") return false;
  const key = [goalId, event, details.nodeId, details.subagentId, details.reason].map((item) => String(item ?? "")).join("\u0000");
  const nowMs = at ? Date.parse(typeof at === "string" ? at : at.toISOString()) : Date.now();
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const previous = recoveryBlockedLedgerCooldown.get(key);
  if (previous !== undefined && effectiveNowMs - previous < RECOVERY_BLOCKED_LEDGER_COOLDOWN_MS) return true;
  recoveryBlockedLedgerCooldown.set(key, effectiveNowMs);
  if (recoveryBlockedLedgerCooldown.size > 1_000) {
    const cutoff = effectiveNowMs - RECOVERY_BLOCKED_LEDGER_COOLDOWN_MS;
    for (const [candidate, timestamp] of recoveryBlockedLedgerCooldown) {
      if (timestamp < cutoff) recoveryBlockedLedgerCooldown.delete(candidate);
    }
  }
  return false;
}

function isTransientError(message: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isContextExceededError(message: string): boolean {
  return CONTEXT_EXCEEDED_PATTERNS.some((pattern) => pattern.test(message));
}

function isProviderLimitError(message: string): boolean {
  return PROVIDER_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isMissingSessionTerminalError(message: string): boolean {
  return MISSING_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isTerminatedSessionError(message: string): boolean {
  return TERMINATED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
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

function buildBlockedNodeRecoveryPrompt(node: GoalDagNode, blockedReason: string, retryCount: number, maxRetries: number): string {
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

function buildContextUpgradePrompt(node: GoalDagNode, oldModel: string, newModel: string): string {
  return [
    `[SYSTEM RECOVERY] The previous model (${oldModel}) ran out of context window.`,
    `You have been restarted with a larger-context model: ${newModel}.`,
    `Please resume your work on: "${node.objective}"`,
    `Report with SUBAGENT_RESULT: <summary> when done, or SUBAGENT_BLOCKED: <reason> if blocked.`,
  ].join("\n");
}

function buildMissingSessionReplacementPrompt(node: GoalDagNode, errorMessage: string, retryCount: number, maxRetries: number): string {
  return buildReplacementPrompt(node, errorMessage, retryCount, maxRetries, "STALE_MISSING_SESSION_REPLACEMENT", "The previous background subagent runner stopped before a usable session transcript existed.");
}

function buildTerminatedSessionReplacementPrompt(node: GoalDagNode, errorMessage: string, retryCount: number, maxRetries: number): string {
  return buildReplacementPrompt(node, errorMessage, retryCount, maxRetries, "TERMINATED_SESSION_REPLACEMENT", "The previous background subagent session repeatedly terminated after same-session recovery attempts.");
}

function buildReplacementPrompt(node: GoalDagNode, errorMessage: string, retryCount: number, maxRetries: number, tag: string, explanation: string): string {
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
  ].filter((line): line is string => Boolean(line)).join("\n");
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

async function startReplacementForMissingSession(
  runtime: GoalControllerRuntimePort,
  adapter: HarnessSubagentAdapter,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  state: GoalOrchestrationState,
  result: GoalControllerTickResult,
  options: GoalControllerTickOptions,
  tickStartedAt: string,
  errorMessage: string,
): Promise<boolean> {
  return startReplacementSubagent(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage, {
    mode: "stale-missing-session",
    prompt: buildMissingSessionReplacementPrompt,
    blockWhenRetryCountAtMax: true,
    terminalSummary: (error) => `stale subagent attempt terminalized: ${error}`,
    replacementSummary: (attempt, maxRetries, previous, error) => `replacement attempt ${attempt}/${maxRetries} for stale missing session ${previous}: ${error}`,
    blockSummary: (retryCount, maxRetries, error) => `blocked: stale subagent session could not be recovered after ${retryCount}/${maxRetries} replacement attempt(s). Error: ${error}`,
  });
}

async function startReplacementForTerminatedSession(
  runtime: GoalControllerRuntimePort,
  adapter: HarnessSubagentAdapter,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  state: GoalOrchestrationState,
  result: GoalControllerTickResult,
  options: GoalControllerTickOptions,
  tickStartedAt: string,
  errorMessage: string,
): Promise<boolean> {
  return startReplacementSubagent(runtime, adapter, node, subagent, state, result, options, tickStartedAt, errorMessage, {
    mode: "terminated-session",
    prompt: buildTerminatedSessionReplacementPrompt,
    blockWhenRetryCountAtMax: false,
    terminalSummary: (error) => `terminated subagent attempt replaced after same-session retries were exhausted: ${error}`,
    replacementSummary: (attempt, maxRetries, previous, error) => `fresh replacement attempt ${attempt}/${maxRetries} after repeated terminated errors in ${previous}: ${error}`,
    blockSummary: (retryCount, maxRetries, error) => `blocked: terminated subagent session could not be recovered after replacement attempt ${retryCount}/${maxRetries}. Error: ${error}`,
  });
}

async function startReplacementSubagent(
  runtime: GoalControllerRuntimePort,
  adapter: HarnessSubagentAdapter,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  state: GoalOrchestrationState,
  result: GoalControllerTickResult,
  options: GoalControllerTickOptions,
  tickStartedAt: string,
  errorMessage: string,
  behavior: {
    mode: string;
    prompt: (node: GoalDagNode, errorMessage: string, retryCount: number, maxRetries: number) => string;
    blockWhenRetryCountAtMax: boolean;
    terminalSummary: (errorMessage: string) => string;
    replacementSummary: (attempt: number, maxRetries: number, previousSubagentId: string, errorMessage: string) => string;
    blockSummary: (retryCount: number, maxRetries: number, errorMessage: string) => string;
  },
): Promise<boolean> {
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

  const allocation = subagent.workspacePath || subagent.branch || subagent.ref
    ? undefined
    : await options.workspaceAllocator?.({ goalId: subagent.goalId, node, state, adapterId: adapter.adapterId, tickStartedAt });
  const replacementPrompt = behavior.prompt(node, errorMessage, retryCount, maxReplacementAttempts);
  const replacementSubagentId = uniqueReplacementSubagentId(state.subagents, subagent.subagentId, attempt);
  const allocatedSubagentId = allocation?.subagentId && allocation.subagentId !== subagent.subagentId ? allocation.subagentId : undefined;
  const startOptions: StartGoalSubagentOptions = {
    subagentId: allocatedSubagentId ?? replacementSubagentId,
    cwd: subagent.workspacePath ?? allocation?.cwd,
    branch: subagent.branch ?? allocation?.branch,
    ref: subagent.ref ?? allocation?.ref,
    systemPrompt: allocation?.systemPrompt ?? options.systemPrompt,
    initialPrompt: replacementPrompt,
    metadata: {
      ...(options.metadata ?? {}),
      ...(allocation?.metadata ?? {}),
      staleReplacementFor: subagent.subagentId,
      staleReplacementMode: behavior.mode,
      staleReplacementReason: errorMessage,
      staleReplacementAttempt: attempt,
    },
    now: tickStartedAt,
    thinkingLevel: node.thinkingLevel,
  };
  const started = await runtime.startGoalSubagent(adapter, node, startOptions);
  const replacement = withSubagentPatch(started, {
    retryCount: attempt,
    integrationStatus: behavior.replacementSummary(attempt, maxReplacementAttempts, subagent.subagentId, errorMessage),
    lastActivityAt: tickStartedAt,
    updatedAt: tickStartedAt,
  });
  await runtime.saveGoalSubagent(replacement);
  await runtime.saveGoalDagNode(withNodePatch(node, {
    status: "running",
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

function uniqueReplacementSubagentId(subagents: GoalSubagentRecord[], baseSubagentId: string, attempt: number): string {
  const existing = new Set(subagents.map((item) => item.subagentId));
  const base = `${baseSubagentId}-retry-${attempt}`;
  if (!existing.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
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
    const fallback = contextFallbackModel(node.modelArg);
    if (!fallback) {
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
    await recordControllerEvent(runtime, subagent.goalId, "recovery.started", {
      nodeId: node.nodeId,
      subagentId: newSubagent.subagentId,
      previousSubagentId: subagent.subagentId,
      fromModel: oldModel,
      toModel: fallback,
      reason: errorMessage,
    }, tickStartedAt);
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
  await recordControllerEvent(runtime, goalId, "poll.started", {
    nodes: initialState.nodes.length,
    subagents: initialState.subagents.length,
  }, tickStartedAt);
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
      if (subagentChanged(subagent, updated)) {
        result.synced.push(updated);
        await recordControllerEvent(runtime, updated.goalId, controllerEventForSyncedSubagent(updated), {
          nodeId: updated.nodeId,
          subagentId: updated.subagentId,
          from: subagent.status,
          to: updated.status,
          summary: updated.selfReportedResult ?? updated.integrationStatus,
        }, tickStartedAt);
      }
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
      const recovered = await tryRecoverBlockedSubagent(runtime, options, state, node, subagent, result, tickStartedAt);
      if (recovered) continue;
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

async function tryRecoverBlockedSubagent(
  runtime: GoalControllerRuntimePort,
  options: GoalControllerTickOptions,
  state: GoalOrchestrationState,
  node: GoalDagNode,
  subagent: GoalSubagentRecord,
  result: GoalControllerTickResult,
  tickStartedAt: string,
): Promise<boolean> {
  const blockedReason = subagent.selfReportedResult ?? subagent.integrationStatus ?? node.lastValidationSummary ?? "blocked";
  if (isProviderLimitError(blockedReason)) return false;

  const maxRetries = options.maxAutoRetries ?? MAX_AUTO_RETRIES_DEFAULT;
  const retryCount = subagent.retryCount ?? 0;
  if (retryCount >= maxRetries) return false;

  try {
    const prompt = buildBlockedNodeRecoveryPrompt(node, blockedReason, retryCount, maxRetries);
    const followed = await runtime.sendGoalSubagentPrompt(options.adapter, subagent, prompt, {
      metadata: options.metadata,
      now: tickStartedAt,
    });
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!isProviderLimitError(errorMessage)) throw error;
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
      const repeatSummary = appendSummary(
        validationSummary,
        `repeated identical controller validation failure (${repeat.count} occurrences); automatic same-session follow-ups are capped at ${MAX_VALIDATION_FOLLOWUPS_FOR_SAME_FAILURE}`,
      );
      const blockedNode = withNodePatch(validatingNode, { status: "blocked", lastValidationSummary: repeatSummary });
      const blockedSubagent = withSubagentPatch(validationResults, { status: "blocked", integrationStatus: repeatSummary });
      await runtime.saveGoalDagNode(blockedNode);
      await runtime.saveGoalSubagent(blockedSubagent);
      await recordControllerEvent(runtime, node.goalId, "validation.followupCapped", {
        nodeId: node.nodeId,
        subagentId: subagent.subagentId,
        summary: repeatSummary,
        occurrences: repeat.count,
      }, tickStartedAt);
      result.blocked.push(blockedNode);
      return;
    }

    const followed = await runtime.sendGoalSubagentPrompt(options.adapter, validationResults, validation.followupPrompt, {
      metadata: options.metadata,
      now: tickStartedAt,
    });
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
    await recordControllerEvent(runtime, node.goalId, "integration.passed", {
      nodeId: node.nodeId,
      subagentId: subagent.subagentId,
      status: integration.status,
      summary: integrationSummary,
      sourceHead: integration.sourceHead,
      integrationCommitSha: integration.integrationCommitSha,
    }, tickStartedAt);
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
    await recordControllerEvent(runtime, node.goalId, "integration.followup", {
      nodeId: node.nodeId,
      subagentId: subagent.subagentId,
      summary: integrationSummary,
      error: integration.error,
    }, tickStartedAt);
    result.followups.push(runningSubagent);
    return;
  }

  const blockedNode = withNodePatch(node, { status: "blocked", lastValidationSummary: appendSummary(validationSummary, `integration failed: ${integrationSummary}`) });
  const blockedSubagent = withSubagentPatch(failedSubagent, { status: "blocked" });
  await runtime.saveGoalDagNode(blockedNode);
  await runtime.saveGoalSubagent(blockedSubagent);
  await recordControllerEvent(runtime, node.goalId, integration.status === "blocked" ? "integration.blocked" : "integration.failed", {
    nodeId: node.nodeId,
    subagentId: subagent.subagentId,
    summary: integrationSummary,
    error: integration.error,
  }, tickStartedAt);
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
  await recordControllerEvent(runtime, node.goalId, "node.complete", {
    nodeId: node.nodeId,
    subagentId: subagent.subagentId,
    summary: validationSummary,
    integrationState: completedSubagent.integrationState,
  }, completedNode.updatedAt);
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

function controllerEventForSyncedSubagent(subagent: GoalSubagentRecord): string {
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

function isTransientStoreLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function appendValidationResults(subagent: GoalSubagentRecord, validation: GoalControllerValidationResult): GoalSubagentRecord {
  const additions = [validation.summary, ...(validation.validationSignals ?? [])].filter((item): item is string => Boolean(item?.trim()));
  if (additions.length === 0) return subagent;
  return { ...subagent, controllerValidationResults: [...(subagent.controllerValidationResults ?? []), ...additions] };
}

function repeatedValidationFailure(subagent: GoalSubagentRecord, validation: GoalControllerValidationResult): { signature?: string; count: number } {
  const signature = validationFailureSignature(validation);
  if (!signature) return { count: 0 };
  const previous = (subagent.controllerValidationResults ?? []).filter((item) => normalizeValidationFailureSignature(item) === signature).length;
  return { signature, count: previous + 1 };
}

function validationFailureSignature(validation: GoalControllerValidationResult): string | undefined {
  return normalizeValidationFailureSignature(validation.summary) ?? (validation.validationSignals ?? []).map(normalizeValidationFailureSignature).find(Boolean);
}

function normalizeValidationFailureSignature(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
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
