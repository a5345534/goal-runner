import type { GoalLedgerEvent, GoalOrchestrationState, GoalRecord, GoalSubagentRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES = [
  "controller_audit_started",
  "controller_audit_finished",
  "controller_audit_invalid_output",
  "controller_audit_action_recommended",
  "controller_audit_action_applied",
  "controller_audit_action_skipped",
  "controller_audit_action_failed",
  "goal_paused_by_controller_audit",
] as const;

export type GoalControllerAuditLedgerEventType = (typeof GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES)[number];

/** Default audit interval: 30 minutes. */
export const DEFAULT_AUDIT_INTERVAL_MS = 30 * 60 * 1000;

/** Default max recent controller events to include in the snapshot. */
export const DEFAULT_MAX_RECENT_EVENTS = 200;

/** Default max recent validation summaries aggregated for the snapshot. */
export const DEFAULT_MAX_RECENT_VALIDATION_RESULTS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalControllerAuditOptions {
  enabled?: boolean;
  intervalMs?: number;
  /** Default: 200. */
  maxRecentEvents?: number;
  /** Default: 50. */
  maxRecentValidationResults?: number;
  maxTokensPerAudit?: number;
  /** Default: true. */
  pauseOnCritical?: boolean;
  /** Default: false. */
  includeTranscriptExcerpts?: boolean;
}

export interface GoalControllerAuditSnapshot {
  goal: {
    goalId: string;
    status: string;
    ageMinutes?: number;
    tokensUsed?: number;
    lastProgressAt?: string;
  };
  nodes: Array<{
    nodeId: string;
    status: string;
    lifecyclePhase?: string;
    retryCount?: number;
    lastValidationSummary?: string;
    lastUpdatedAt?: string;
  }>;
  subagents: Array<{
    subagentId: string;
    nodeId: string;
    status: string;
    retryCount?: number;
    lastActivityAt?: string;
    lastAdapterObservation?: string;
    integrationState?: string;
  }>;
  recentControllerEvents: Array<{
    at: string;
    type: string;
    nodeId?: string;
    subagentId?: string;
    summary?: string;
  }>;
  recentValidationSummaries: Array<{
    nodeId: string;
    summary: string;
    countInWindow: number;
  }>;
  progressSignals: {
    completedNodesLastWindow: number;
    validationFailuresLastWindow: number;
    followupsLastWindow: number;
    retriesLastWindow: number;
    integrationsFailedLastWindow: number;
  };
  costSignals?: {
    tokensLastWindow?: number;
    estimatedCostLastWindow?: number;
  };
}

export interface GoalControllerAuditDecision {
  risk: "low" | "medium" | "high" | "critical";
  summary: string;
  findings: Array<{
    kind:
      | "retry-loop"
      | "no-progress"
      | "invalid-contract-suspected"
      | "cost-spike"
      | "stale-runner"
      | "repeated-validation-failure"
      | "integration-loop"
      | "provider-or-quota-issue"
      | "unknown";
    nodeId?: string;
    subagentId?: string;
    evidence: string[];
    confidence: "low" | "medium" | "high";
  }>;
  recommendedActions: Array<{
    action:
      | "noop"
      | "pause-goal"
      | "cap-retries"
      | "stop-launching-new-subagents"
      | "reduce-concurrency"
      | "request-user-intervention"
      | "open-diagnostic-report"
      | "run-deterministic-contract-check"
      | "mark-node-blocked";
    nodeId?: string;
    subagentId?: string;
    reason: string;
    requiresUserApproval: boolean;
  }>;
}

/** Result returned by {@link applyAuditActions}. */
export interface AuditActionPolicyResult {
  /** Whether the goal should be paused by this audit. */
  shouldPauseGoal: boolean;
  /** Human-readable reason for the pause, if applicable. */
  pauseReason?: string;
  /** Actions that were applied (currently only `pause-goal` may be auto-applied). */
  applied: Array<{
    action: GoalControllerAuditDecision["recommendedActions"][number];
    matchedFinding: GoalControllerAuditDecision["findings"][number];
  }>;
  /** Actions that were skipped with a reason. */
  skipped: Array<{
    action: GoalControllerAuditDecision["recommendedActions"][number];
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Audit scheduling
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a controller audit is due for the current goal.
 * Audit is due when it is enabled, the configured interval has elapsed since
 * the last audit, or no previous audit has run.
 */
export function isAuditDue(
  options: GoalControllerAuditOptions,
  lastAuditAt?: string | Date,
  now?: Date,
): boolean {
  if (!options.enabled) return false;
  const effectiveNow = now ?? new Date();
  if (!lastAuditAt) return true;
  const intervalMs = options.intervalMs ?? DEFAULT_AUDIT_INTERVAL_MS;
  const lastMs =
    typeof lastAuditAt === "string"
      ? new Date(lastAuditAt).getTime()
      : lastAuditAt.getTime();
  if (!Number.isFinite(lastMs)) return true;
  return effectiveNow.getTime() - lastMs >= intervalMs;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

/**
 * Builds a bounded structured {@link GoalControllerAuditSnapshot} from
 * trusted runtime state.  Transcripts are excluded unless
 * `options.includeTranscriptExcerpts` is `true`.
 */
export function buildControllerAuditSnapshot(params: {
  state: GoalOrchestrationState;
  goal: GoalRecord;
  recentEvents: GoalLedgerEvent[];
  options: GoalControllerAuditOptions;
  now?: Date;
}): GoalControllerAuditSnapshot {
  const { state, goal, recentEvents, options, now } = params;
  const effectiveNow = now ?? new Date();
  const maxEvents = options.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS;
  const maxValidation = options.maxRecentValidationResults ?? DEFAULT_MAX_RECENT_VALIDATION_RESULTS;

  // Map latest subagent per node for retry-count lookups.
  const latestSubagentByNode = new Map<string, GoalSubagentRecord>();
  for (const subagent of state.subagents) {
    const existing = latestSubagentByNode.get(subagent.nodeId);
    if (!existing || (subagent.createdAt ?? "") >= (existing.createdAt ?? "")) {
      latestSubagentByNode.set(subagent.nodeId, subagent);
    }
  }

  const goalAgeMs = effectiveNow.getTime() - new Date(goal.createdAt).getTime();

  return {
    goal: {
      goalId: goal.goalId,
      status: goal.status,
      ageMinutes: Number.isFinite(goalAgeMs)
        ? Math.round(goalAgeMs / 60_000)
        : undefined,
      tokensUsed: goal.tokensUsed,
      lastProgressAt: goal.updatedAt,
    },
    nodes: state.nodes.map((node) => {
      const latestSubagent = latestSubagentByNode.get(node.nodeId);
      return {
        nodeId: node.nodeId,
        status: node.status,
        lifecyclePhase: node.lifecyclePhase,
        retryCount: latestSubagent?.retryCount,
        lastValidationSummary: node.lastValidationSummary,
        lastUpdatedAt: node.updatedAt,
      };
    }),
    subagents: state.subagents.map((subagent) => ({
      subagentId: subagent.subagentId,
      nodeId: subagent.nodeId,
      status: subagent.status,
      retryCount: subagent.retryCount,
      lastActivityAt: subagent.lastActivityAt,
      lastAdapterObservation: subagent.lastAdapterObservation?.kind,
      integrationState: subagent.integrationState,
    })),
    recentControllerEvents: recentEvents
      .filter((event) => event.type === "controller_event")
      .slice(-maxEvents)
      .map((event) => ({
        at: event.at,
        type: (event.details?.event as string) ?? event.type,
        nodeId: event.details?.nodeId as string | undefined,
        subagentId: event.details?.subagentId as string | undefined,
        summary: event.details?.summary as string | undefined,
      })),
    recentValidationSummaries: buildValidationSummaryAggregates(
      state,
      recentEvents,
      maxValidation,
    ),
    progressSignals: buildProgressSignals(state, recentEvents),
    costSignals: buildCostSignals(goal, recentEvents),
  };
}

function buildCostSignals(
  goal: GoalRecord,
  recentEvents: GoalLedgerEvent[],
): GoalControllerAuditSnapshot["costSignals"] {
  // Estimate tokens used in the window by counting turn_finished events.
  // Falls back to undefined when the ledger does not carry per-event
  // token details.
  let tokensLastWindow: number | undefined;
  let estimatedCostLastWindow: number | undefined;

  const turnFinishedEvents = recentEvents.filter(
    (event) => event.type === "turn_finished",
  );

  if (turnFinishedEvents.length > 0) {
    // Sum token usage from event details when available.
    let windowTokens = 0;
    let hasTokenData = false;
    for (const event of turnFinishedEvents) {
      const details = event.details as Record<string, unknown> | undefined;
      const tokens = details?.tokensUsedDelta as number | undefined;
      if (typeof tokens === "number" && Number.isFinite(tokens)) {
        windowTokens += tokens;
        hasTokenData = true;
      }
    }
    if (hasTokenData) {
      tokensLastWindow = windowTokens;
      // Rough cost estimate: $0.01 per 1K tokens (conservative blended rate).
      estimatedCostLastWindow = Math.round((windowTokens / 1000) * 0.01 * 100) / 100;
    }
  }

  return tokensLastWindow !== undefined
    ? { tokensLastWindow, estimatedCostLastWindow }
    : undefined;
}

function buildValidationSummaryAggregates(
  state: GoalOrchestrationState,
  recentEvents: GoalLedgerEvent[],
  maxResults: number,
): GoalControllerAuditSnapshot["recentValidationSummaries"] {
  const validationEvents = recentEvents.filter(
    (event) =>
      event.type === "controller_event" &&
      (event.details?.event as string)?.startsWith("validation."),
  );

  const counts = new Map<string, { summary: string; count: number }>();
  for (const node of state.nodes) {
    if (node.lastValidationSummary) {
      counts.set(node.nodeId, {
        summary: node.lastValidationSummary,
        count: validationEvents.filter(
          (event) => event.details?.nodeId === node.nodeId,
        ).length,
      });
    }
  }

  return [...counts.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, maxResults)
    .map(([nodeId, { summary, count }]) => ({
      nodeId,
      summary,
      countInWindow: count,
    }));
}

function buildProgressSignals(
  state: GoalOrchestrationState,
  recentEvents: GoalLedgerEvent[],
): GoalControllerAuditSnapshot["progressSignals"] {
  // Count nodes that reached terminal "complete" during the event window.
  const completedNodesLastWindow = recentEvents.filter(
    (event) =>
      event.type === "controller_event" &&
      (event.details?.event as string) === "node.complete",
  ).length;

  const validationFailuresLastWindow = recentEvents.filter(
    (event) =>
      event.type === "controller_event" &&
      (event.details?.event as string) === "validation.failed",
  ).length;

  const followupsLastWindow = recentEvents.filter(
    (event) =>
      event.type === "controller_event" &&
      (event.details?.event as string)?.startsWith("followup."),
  ).length;

  // Count retry-indicating events in the window (recovery decisions,
  // continuation retryable failures, and explicit retry controller events)
  // instead of summing cumulative subagent.retryCount.
  const retriesLastWindow = recentEvents.filter(
    (event) =>
      event.type === "continuation_retryable_failure" ||
      (event.type === "controller_event" &&
        ((event.details?.event as string)?.startsWith("recovery.") ?? false)),
  ).length;

  // Count integration failures that occurred in the window.
  const integrationsFailedLastWindow = recentEvents.filter(
    (event) =>
      event.type === "controller_event" &&
      ((event.details?.event as string) === "integration.failed" ||
        (event.details?.event as string)?.startsWith("integration.result") === true),
  ).length || state.subagents.filter(
    (subagent) => subagent.integrationState === "failed",
  ).length;

  return {
    completedNodesLastWindow,
    validationFailuresLastWindow,
    followupsLastWindow,
    retriesLastWindow,
    integrationsFailedLastWindow,
  };
}

// ---------------------------------------------------------------------------
// Decision validator
// ---------------------------------------------------------------------------

const VALID_RISK_VALUES = new Set(["low", "medium", "high", "critical"]);
const VALID_FINDING_KINDS = new Set([
  "retry-loop",
  "no-progress",
  "invalid-contract-suspected",
  "cost-spike",
  "stale-runner",
  "repeated-validation-failure",
  "integration-loop",
  "provider-or-quota-issue",
  "unknown",
]);
const VALID_CONFIDENCE_VALUES = new Set(["low", "medium", "high"]);
const VALID_ACTION_TYPES = new Set([
  "noop",
  "pause-goal",
  "cap-retries",
  "stop-launching-new-subagents",
  "reduce-concurrency",
  "request-user-intervention",
  "open-diagnostic-report",
  "run-deterministic-contract-check",
  "mark-node-blocked",
]);

/**
 * Validates a candidate object against the
 * {@link GoalControllerAuditDecision} schema.
 *
 * Returns `{ valid: true, decision }` when the candidate passes all
 * structural checks, or `{ valid: false, errors }` listing every
 * detected issue.
 */
export function validateControllerAuditDecision(
  candidate: unknown,
):
  | { valid: true; decision: GoalControllerAuditDecision }
  | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (candidate === null || candidate === undefined) {
    return { valid: false, errors: ["decision is null or undefined"] };
  }
  if (typeof candidate !== "object") {
    return { valid: false, errors: ["decision is not an object"] };
  }

  const obj = candidate as Record<string, unknown>;

  // --- risk ---
  if (typeof obj.risk !== "string" || !VALID_RISK_VALUES.has(obj.risk)) {
    errors.push(
      `risk must be one of [${[...VALID_RISK_VALUES].join(", ")}], got ${JSON.stringify(obj.risk)}`,
    );
  }

  // --- summary ---
  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    errors.push("summary must be a non-empty string");
  }

  // --- findings ---
  if (!Array.isArray(obj.findings)) {
    errors.push("findings must be an array");
  } else {
    for (let index = 0; index < obj.findings.length; index += 1) {
      const finding = obj.findings[index];
      const prefix = `findings[${index}]`;
      if (finding === null || typeof finding !== "object") {
        errors.push(`${prefix} is not an object`);
        continue;
      }
      const item = finding as Record<string, unknown>;
      if (typeof item.kind !== "string" || !VALID_FINDING_KINDS.has(item.kind)) {
        errors.push(
          `${prefix}.kind must be one of [${[...VALID_FINDING_KINDS].join(", ")}], got ${JSON.stringify(item.kind)}`,
        );
      }
      if (
        typeof item.confidence !== "string" ||
        !VALID_CONFIDENCE_VALUES.has(item.confidence)
      ) {
        errors.push(
          `${prefix}.confidence must be one of [${[...VALID_CONFIDENCE_VALUES].join(", ")}], got ${JSON.stringify(item.confidence)}`,
        );
      }
      if (!Array.isArray(item.evidence)) {
        errors.push(`${prefix}.evidence must be an array`);
      } else if (
        item.evidence.length > 0 &&
        item.evidence.some((entry: unknown) => typeof entry !== "string")
      ) {
        errors.push(`${prefix}.evidence entries must be strings`);
      }
      if (item.nodeId !== undefined && typeof item.nodeId !== "string") {
        errors.push(`${prefix}.nodeId must be a string when present`);
      }
      if (item.subagentId !== undefined && typeof item.subagentId !== "string") {
        errors.push(`${prefix}.subagentId must be a string when present`);
      }
    }
  }

  // --- recommendedActions ---
  if (!Array.isArray(obj.recommendedActions)) {
    errors.push("recommendedActions must be an array");
  } else {
    for (let index = 0; index < obj.recommendedActions.length; index += 1) {
      const action = obj.recommendedActions[index];
      const prefix = `recommendedActions[${index}]`;
      if (action === null || typeof action !== "object") {
        errors.push(`${prefix} is not an object`);
        continue;
      }
      const item = action as Record<string, unknown>;
      if (
        typeof item.action !== "string" ||
        !VALID_ACTION_TYPES.has(item.action)
      ) {
        errors.push(
          `${prefix}.action must be one of [${[...VALID_ACTION_TYPES].join(", ")}], got ${JSON.stringify(item.action)}`,
        );
      }
      if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
        errors.push(`${prefix}.reason must be a non-empty string`);
      }
      if (typeof item.requiresUserApproval !== "boolean") {
        errors.push(`${prefix}.requiresUserApproval must be a boolean`);
      }
      if (item.nodeId !== undefined && typeof item.nodeId !== "string") {
        errors.push(`${prefix}.nodeId must be a string when present`);
      }
      if (item.subagentId !== undefined && typeof item.subagentId !== "string") {
        errors.push(`${prefix}.subagentId must be a string when present`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, decision: obj as unknown as GoalControllerAuditDecision };
}

// ---------------------------------------------------------------------------
// Safe action policy
// ---------------------------------------------------------------------------

/**
 * Evaluates a validated audit decision against the safe action policy.
 *
 * ## Policy rules
 *
 * 1. **`pause-goal` auto-action** — applied when ALL hold:
 *    - `decision.risk === "critical"`
 *    - At least one finding has `confidence === "high"`
 *    - `options.pauseOnCritical` is enabled (default `true`)
 *
 * 2. **All other actions** (including `pause-goal` recommendations that do
 *    not meet the auto-pause criteria) are recorded as **skipped** and
 *    require deterministic confirmation before they can be applied.
 *
 * This function is a pure policy evaluator; it does **not** mutate
 * runtime state.  The caller is responsible for pausing the goal and
 * recording ledger events based on the returned result.
 */
export function applyAuditActions(
  decision: GoalControllerAuditDecision,
  options: GoalControllerAuditOptions,
): AuditActionPolicyResult {
  const pauseOnCritical = options.pauseOnCritical !== false; // default true
  const hasHighConfidenceFinding = decision.findings.some(
    (finding) => finding.confidence === "high",
  );
  const autoPauseEnabled =
    decision.risk === "critical" && hasHighConfidenceFinding && pauseOnCritical;

  const applied: AuditActionPolicyResult["applied"] = [];
  const skipped: AuditActionPolicyResult["skipped"] = [];
  let shouldPauseGoal = false;
  let pauseReason: string | undefined;

  for (const action of decision.recommendedActions) {
    if (action.action === "pause-goal") {
      if (autoPauseEnabled) {
        const matchedFinding =
          decision.findings.find(
            (finding) => finding.confidence === "high",
          ) ??
          // Fallback: use any finding if no high-confidence one exists
          // (should not happen given the autoPauseEnabled guard).
          decision.findings[0];
        applied.push({ action, matchedFinding });
        shouldPauseGoal = true;
        pauseReason = `Controller audit (risk: ${decision.risk}) — ${decision.summary}`;
      } else {
        const reason = buildSkipReason(
          action,
          decision.risk,
          hasHighConfidenceFinding,
          pauseOnCritical,
        );
        skipped.push({ action, reason });
      }
    } else if (action.action === "noop") {
      // noop actions are neither applied nor skipped — they are informative.
    } else {
      skipped.push({
        action,
        reason: `Action "${action.action}" requires deterministic confirmation; not auto-applied.`,
      });
    }
  }

  return { shouldPauseGoal, pauseReason, applied, skipped };
}

function buildSkipReason(
  action: GoalControllerAuditDecision["recommendedActions"][number],
  risk: GoalControllerAuditDecision["risk"],
  hasHighConfidence: boolean,
  pauseOnCritical: boolean,
): string {
  const reasons: string[] = [];
  if (risk !== "critical") {
    reasons.push(`risk is "${risk}", not "critical"`);
  }
  if (!hasHighConfidence) {
    reasons.push("no finding has high confidence");
  }
  if (!pauseOnCritical) {
    reasons.push("pauseOnCritical is disabled");
  }
  return (
    `"pause-goal" not auto-applied: ${reasons.join("; ")}.` ||
    `"pause-goal" not auto-applied.`
  );
}

// ---------------------------------------------------------------------------
// Audit action event recording
// ---------------------------------------------------------------------------

/** Callback for recording a single audit lifecycle ledger event. */
export type AuditEventRecorder = (
  eventType: GoalControllerAuditLedgerEventType,
  details: Record<string, unknown>,
  at?: Date | string,
) => void | Promise<void>;

/**
 * Records the full audit action outcome, including definitive pause events.
 *
 * This helper records `controller_audit_action_recommended` and
 * `controller_audit_action_skipped` events via
 * {@link recordAuditActionDecisions}, then unconditionally emits
 * `goal_paused_by_controller_audit` when `result.shouldPauseGoal` is
 * `true`.
 *
 * **Important:** the controller loop does **not** use this function for
 * the normal audit gate flow. It calls {@link recordAuditActionDecisions}
 * to record the policy recommendation **before** the actual pause, and
 * then emits `controller_audit_action_applied` +
 * `goal_paused_by_controller_audit` only after a successful
 * `runtime.auditPauseGoal()` call. Callers that follow the same split
 * (recommend → pause → record) should use `recordAuditActionDecisions`
 * and record the definitive events manually.
 *
 * This function is appropriate for callers that have already applied the
 * pause (for example test helpers or deferred-replay flows) and want to
 * emit the full event batch atomically.
 *
 * The caller must supply an {@link AuditEventRecorder} that writes to the
 * durable goal ledger.
 */
export async function recordAuditActionEvents(
  result: AuditActionPolicyResult,
  decision: GoalControllerAuditDecision,
  recorder: AuditEventRecorder,
  at?: Date | string,
): Promise<void> {
  await recordAuditActionDecisions(result, decision, recorder, at);

  if (result.shouldPauseGoal) {
    await recorder(
      "goal_paused_by_controller_audit",
      {
        risk: decision.risk,
        summary: decision.summary,
        pauseReason: result.pauseReason,
        appliedActions: result.applied.map((entry) => entry.action.action),
        findingKinds: decision.findings.map((finding) => finding.kind),
      },
      at,
    );
  }
}

/**
 * Records applied/skipped action decisions without recording a definitive
 * pause event. Use {@link recordAuditActionEvents} when the caller has
 * already successfully paused (or when working with a full-pipeline
 * recorder). Callers that need to separate decision recording from the
 * actual pause (for correct ledger ordering) should call this function
 * before pausing and then emit `goal_paused_by_controller_audit` only after
 * a successful pause.
 */
export async function recordAuditActionDecisions(
  result: AuditActionPolicyResult,
  decision: GoalControllerAuditDecision,
  recorder: AuditEventRecorder,
  at?: Date | string,
): Promise<void> {
  for (const entry of result.applied) {
    await recorder(
      "controller_audit_action_recommended",
      {
        action: entry.action.action,
        reason: entry.action.reason,
        matchedFindingKind: entry.matchedFinding.kind,
        matchedFindingConfidence: entry.matchedFinding.confidence,
        nodeId: entry.action.nodeId ?? entry.matchedFinding.nodeId,
        subagentId: entry.action.subagentId ?? entry.matchedFinding.subagentId,
        risk: decision.risk,
      },
      at,
    );
  }

  for (const entry of result.skipped) {
    await recorder(
      "controller_audit_action_skipped",
      {
        action: entry.action.action,
        reason: entry.reason,
        nodeId: entry.action.nodeId,
        subagentId: entry.action.subagentId,
        risk: decision.risk,
      },
      at,
    );
  }
}

// ---------------------------------------------------------------------------
// Audit summary formatting
// ---------------------------------------------------------------------------

/**
 * Renders a compact single-line audit summary suitable for monitor/status
 * display.
 *
 * Format: `Controller audit: <risk> <finding-kinds> on <nodeIds>; <applied actions>`
 */
export function formatAuditSummary(
  decision: GoalControllerAuditDecision,
  appliedActions: AuditActionPolicyResult["applied"],
): string {
  const kindText =
    decision.findings.length > 0
      ? decision.findings
          .map((finding) => finding.kind)
          .filter((value, index, array) => array.indexOf(value) === index) // unique
          .join(", ")
      : "none";

  const nodeIds = [
    ...new Set(
      decision.findings
        .map((finding) => finding.nodeId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const nodeText = nodeIds.length > 0 ? ` on ${nodeIds.join(", ")}` : "";

  const appliedText =
    appliedActions.length > 0
      ? `; ${appliedActions.map((entry) => entry.action.action).join(", ")} applied`
      : "";

  return `Controller audit: ${decision.risk} ${kindText}${nodeText}${appliedText}`;
}
