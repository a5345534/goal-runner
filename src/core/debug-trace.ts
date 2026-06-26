import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { findRequiredSubagentIntegrationIssues } from "./integration.js";
import { resolveDefaultStateRoot } from "./state-root.js";
import type {
  ContinuationReservation,
  GoalDagNode,
  GoalLedgerEvent,
  GoalOrchestrationState,
  GoalRecord,
  GoalSessionMetadata,
  GoalStore,
  GoalSubagentRecord,
  GoalSummary,
  HarnessState,
  WorkspaceProfile,
} from "./types.js";

export type GoalDebugTraceCategory = "db" | "controller" | "monitor" | "anomaly" | "runtime";
export type GoalDebugSeverity = "debug" | "info" | "warn" | "error";

export interface GoalDebugTraceEvent {
  traceId: string;
  at: string;
  category: GoalDebugTraceCategory;
  operation: string;
  severity: GoalDebugSeverity;
  ok?: boolean;
  durationMs?: number;
  sessionKey?: string;
  goalId?: string;
  nodeId?: string;
  subagentId?: string;
  summary?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export type GoalDebugTraceEventInput = Omit<GoalDebugTraceEvent, "traceId" | "at"> & {
  traceId?: string;
  at?: string;
};

export interface GoalDebugTracer {
  readonly enabled: boolean;
  record(event: GoalDebugTraceEventInput): Promise<void> | void;
  trace<T>(
    category: GoalDebugTraceCategory,
    operation: string,
    context: Omit<GoalDebugTraceEventInput, "category" | "operation" | "ok" | "durationMs" | "error">,
    action: () => Promise<T> | T,
  ): Promise<T>;
  getTraceTarget?(): string | undefined;
}

export interface JsonlGoalDebugTracerOptions {
  traceDir?: string;
  traceFile?: string;
  stateRoot?: string;
  now?: () => Date;
  randomId?: () => string;
}

export class JsonlGoalDebugTracer implements GoalDebugTracer {
  readonly enabled = true;
  private readonly traceFile: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(options: JsonlGoalDebugTracerOptions = {}) {
    const traceDir = options.traceDir ?? resolve(resolveDefaultStateRoot(options.stateRoot), "debug-traces");
    this.traceFile = resolve(options.traceFile ?? resolve(traceDir, `goal-runner-debug-${formatDay(options.now?.() ?? new Date())}.jsonl`));
    mkdirSync(resolve(this.traceFile, ".."), { recursive: true });
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID());
  }

  getTraceTarget(): string {
    return this.traceFile;
  }

  record(input: GoalDebugTraceEventInput): void {
    const at = input.at ?? this.now().toISOString();
    const event: GoalDebugTraceEvent = {
      traceId: input.traceId ?? this.randomId(),
      at,
      category: input.category,
      operation: input.operation,
      severity: input.severity,
      ok: input.ok,
      durationMs: input.durationMs,
      sessionKey: input.sessionKey,
      goalId: input.goalId,
      nodeId: input.nodeId,
      subagentId: input.subagentId,
      summary: input.summary,
      error: input.error,
      details: sanitizeDebugDetails(input.details),
    };
    appendFileSync(this.traceFile, `${JSON.stringify(dropUndefined(event))}\n`, "utf8");
  }

  async trace<T>(
    category: GoalDebugTraceCategory,
    operation: string,
    context: Omit<GoalDebugTraceEventInput, "category" | "operation" | "ok" | "durationMs" | "error">,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const started = Date.now();
    try {
      const value = await action();
      this.record({ ...context, category, operation, ok: true, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      this.record({
        ...context,
        category,
        operation,
        severity: context.severity ?? "error",
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export function createGoalDebugTracerFromEnv(options: { stateRoot?: string; defaultEnabled?: boolean } = {}): GoalDebugTracer | undefined {
  const setting = process.env.GOAL_RUNNER_DEBUG_TRACE ?? process.env.AGENT_GOAL_DEBUG_TRACE;
  const enabled = setting === undefined ? options.defaultEnabled === true : !isFalseyEnv(setting);
  if (!enabled) return undefined;
  const traceFile = process.env.GOAL_RUNNER_DEBUG_TRACE_FILE || process.env.AGENT_GOAL_DEBUG_TRACE_FILE || undefined;
  const traceDir = process.env.GOAL_RUNNER_DEBUG_TRACE_DIR || process.env.AGENT_GOAL_DEBUG_TRACE_DIR || undefined;
  return new JsonlGoalDebugTracer({ stateRoot: options.stateRoot, traceDir, traceFile });
}

export function instrumentGoalStore(store: GoalStore, tracer: GoalDebugTracer | undefined): GoalStore {
  if (!tracer?.enabled) return store;
  return new InstrumentedGoalStore(store, tracer);
}

class InstrumentedGoalStore implements GoalStore {
  constructor(private readonly store: GoalStore, private readonly tracer: GoalDebugTracer) {}

  async getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined> {
    return this.trace("getCurrentGoal", { sessionKey }, () => this.store.getCurrentGoal(sessionKey), summarizeGoalRecord);
  }

  async saveGoal(goal: GoalRecord): Promise<void> {
    return this.trace("saveGoal", goalContext(goal), () => this.store.saveGoal(goal));
  }

  async clearGoal(sessionKey: string): Promise<void> {
    return this.trace("clearGoal", { sessionKey }, () => this.store.clearGoal(sessionKey));
  }

  async getReservation(sessionKey: string): Promise<ContinuationReservation | undefined> {
    return this.trace("getReservation", { sessionKey }, () => this.store.getReservation(sessionKey), summarizeReservation);
  }

  async saveReservation(reservation: ContinuationReservation): Promise<void> {
    return this.trace("saveReservation", { sessionKey: reservation.sessionKey, goalId: reservation.goalId, details: { attemptCount: reservation.attemptCount, status: reservation.status } }, () => this.store.saveReservation(reservation));
  }

  async clearReservation(sessionKey: string): Promise<void> {
    return this.trace("clearReservation", { sessionKey }, () => this.store.clearReservation(sessionKey));
  }

  async clearExpiredReservations(now?: Date): Promise<number> {
    return this.trace("clearExpiredReservations", { details: { now: now?.toISOString() } }, () => this.store.clearExpiredReservations(now), (count) => ({ count }));
  }

  async appendLedgerEvent(event: GoalLedgerEvent): Promise<void> {
    return this.trace("appendLedgerEvent", { sessionKey: event.sessionKey, goalId: event.goalId, details: { type: event.type } }, () => this.store.appendLedgerEvent(event));
  }

  async listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]> {
    return this.trace("listLedgerEvents", { sessionKey, goalId }, () => this.store.listLedgerEvents(sessionKey, goalId), summarizeLedgerEvents);
  }

  async saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void> {
    return this.trace(
      "saveGoalSessionMetadata",
      {
        sessionKey: metadata.sessionKey,
        goalId: metadata.goalId,
        details: {
          workspaceStatus: metadata.workspaceStatus,
          branchVerificationStatus: metadata.branchVerificationStatus,
          hasSessionFile: Boolean(metadata.sessionFile),
          hasExecutionWorkspace: Boolean(metadata.executionWorkspace),
        },
      },
      () => this.store.saveGoalSessionMetadata(metadata),
    );
  }

  async getGoalSessionMetadata(sessionKey: string): Promise<GoalSessionMetadata | undefined> {
    return this.trace("getGoalSessionMetadata", { sessionKey }, () => this.store.getGoalSessionMetadata(sessionKey), (metadata) => metadata ? { goalId: metadata.goalId, workspaceStatus: metadata.workspaceStatus } : { result: "none" });
  }

  async listGoalSummaries(): Promise<GoalSummary[]> {
    return this.trace("listGoalSummaries", {}, () => this.store.listGoalSummaries(), (summaries) => ({ count: summaries.length, statuses: countBy(summaries.map((goal) => goal.status)) }));
  }

  async saveGoalDagNode(node: GoalDagNode): Promise<void> {
    return this.trace("saveGoalDagNode", nodeContext(node), () => this.store.saveGoalDagNode(node));
  }

  async getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined> {
    return this.trace("getGoalDagNode", { goalId, nodeId }, () => this.store.getGoalDagNode(goalId, nodeId), summarizeNode);
  }

  async listGoalDagNodes(goalId: string): Promise<GoalDagNode[]> {
    return this.trace("listGoalDagNodes", { goalId }, () => this.store.listGoalDagNodes(goalId), summarizeNodes);
  }

  async saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void> {
    return this.trace("saveGoalSubagent", subagentContext(subagent), () => this.store.saveGoalSubagent(subagent));
  }

  async getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined> {
    return this.trace("getGoalSubagent", { goalId, subagentId }, () => this.store.getGoalSubagent(goalId, subagentId), summarizeSubagent);
  }

  async listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]> {
    return this.trace("listGoalSubagents", { goalId, nodeId }, () => this.store.listGoalSubagents(goalId, nodeId), summarizeSubagents);
  }

  async saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void> {
    return this.trace("saveWorkspaceProfile", { details: { name: profile.name, kind: profile.kind, hasBranch: Boolean(profile.branch), hasRef: Boolean(profile.ref) } }, () => this.store.saveWorkspaceProfile(profile));
  }

  async getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined> {
    return this.trace("getWorkspaceProfile", { details: { name } }, () => this.store.getWorkspaceProfile(name), (profile) => profile ? { name: profile.name, kind: profile.kind } : { result: "none" });
  }

  async listWorkspaceProfiles(): Promise<WorkspaceProfile[]> {
    return this.trace("listWorkspaceProfiles", {}, () => this.store.listWorkspaceProfiles(), (profiles) => ({ count: profiles.length }));
  }

  async deleteWorkspaceProfile(name: string): Promise<boolean> {
    return this.trace("deleteWorkspaceProfile", { details: { name } }, () => this.store.deleteWorkspaceProfile(name), (deleted) => ({ deleted }));
  }

  async pruneLedgerEvents(goalId: string, options: { maxEvents: number }): Promise<number> {
    const prune = this.store.pruneLedgerEvents?.bind(this.store);
    if (!prune) return 0;
    return this.trace("pruneLedgerEvents", { goalId, details: { maxEvents: options.maxEvents } }, () => prune(goalId, options), (pruned) => ({ pruned }));
  }

  async close(): Promise<void> {
    const close = this.store.close?.bind(this.store);
    if (!close) return;
    await this.trace("close", {}, () => Promise.resolve(close()));
  }

  private async trace<T>(
    operation: string,
    context: Partial<Pick<GoalDebugTraceEventInput, "sessionKey" | "goalId" | "nodeId" | "subagentId" | "details">>,
    action: () => Promise<T>,
    summarize?: (value: T) => Record<string, unknown>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const value = await action();
      this.tracer.record({
        category: "db",
        operation,
        severity: "debug",
        ok: true,
        durationMs: Date.now() - started,
        sessionKey: context.sessionKey,
        goalId: context.goalId,
        nodeId: context.nodeId,
        subagentId: context.subagentId,
        details: mergeDetails(context.details, summarize?.(value)),
      });
      return value;
    } catch (error) {
      this.tracer.record({
        category: "db",
        operation,
        severity: "error",
        ok: false,
        durationMs: Date.now() - started,
        sessionKey: context.sessionKey,
        goalId: context.goalId,
        nodeId: context.nodeId,
        subagentId: context.subagentId,
        error: error instanceof Error ? error.message : String(error),
        details: context.details,
      });
      throw error;
    }
  }
}

export interface GoalDebugAnomaly {
  code: string;
  severity: "warn" | "error";
  summary: string;
  goalId: string;
  nodeId?: string;
  subagentId?: string;
  details?: Record<string, unknown>;
}

export interface GoalDebugReport {
  generatedAt: string;
  traceTarget?: string;
  goal: {
    goalId: string;
    shortGoalId: string;
    sessionKey: string;
    status: string;
    activityState?: string;
    objectiveSummary: string;
    tokensUsed: number;
    tokenBudget?: number;
    timeUsedSeconds: number;
    executionWorkspace?: string;
    sessionFile?: string;
    updatedAt: string;
  };
  counts: {
    nodes: number;
    subagents: number;
    ledgerEvents: number;
    nodeStatuses: Record<string, number>;
    subagentStatuses: Record<string, number>;
  };
  anomalies: GoalDebugAnomaly[];
  nodes: Array<{
    nodeId: string;
    slug: string;
    status: string;
    lifecyclePhase?: string;
    dependencyNodeIds: string[];
    preparedSubagentId?: string;
    launchFailureCount?: number;
    updatedAt: string;
    lastValidationSummary?: string;
  }>;
  subagents: Array<{
    subagentId: string;
    nodeId: string;
    status: string;
    sessionId?: string;
    hasSessionFile: boolean;
    hasWorkspace: boolean;
    integrationState?: string;
    retryCount?: number;
    updatedAt: string;
    lastActivityAt?: string;
    integrationStatus?: string;
  }>;
  recentEvents: Array<{ at: string; type: string; summary?: string; nodeId?: string; subagentId?: string }>;
}

export function buildGoalDebugReport(input: {
  goal: GoalSummary | GoalRecord;
  state: GoalOrchestrationState;
  ledgerEvents?: GoalLedgerEvent[];
  harnessState?: HarnessState;
  reservation?: ContinuationReservation;
  traceTarget?: string;
  now?: Date;
}): GoalDebugReport {
  const goal = normalizeGoalDebugGoal(input.goal);
  const ledgerEvents = input.ledgerEvents ?? [];
  const anomalies = detectGoalDebugAnomalies({
    goal: input.goal,
    state: input.state,
    ledgerEvents,
    harnessState: input.harnessState,
    reservation: input.reservation,
    now: input.now,
  });
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    traceTarget: input.traceTarget,
    goal,
    counts: {
      nodes: input.state.nodes.length,
      subagents: input.state.subagents.length,
      ledgerEvents: ledgerEvents.length,
      nodeStatuses: countBy(input.state.nodes.map((node) => node.status)),
      subagentStatuses: countBy(input.state.subagents.map((subagent) => subagent.status)),
    },
    anomalies,
    nodes: input.state.nodes.map((node) => ({
      nodeId: node.nodeId,
      slug: node.slug,
      status: node.status,
      lifecyclePhase: node.lifecyclePhase,
      dependencyNodeIds: node.dependencyNodeIds,
      preparedSubagentId: node.preparedResources?.subagentId,
      launchFailureCount: runnerLaunchFailureCount(node),
      updatedAt: node.updatedAt,
      lastValidationSummary: node.lastValidationSummary,
    })),
    subagents: input.state.subagents.map((subagent) => ({
      subagentId: subagent.subagentId,
      nodeId: subagent.nodeId,
      status: subagent.status,
      sessionId: subagent.sessionId,
      hasSessionFile: Boolean(subagent.sessionFile),
      hasWorkspace: Boolean(subagent.workspacePath),
      integrationState: subagent.integrationState,
      retryCount: subagent.retryCount,
      updatedAt: subagent.updatedAt,
      lastActivityAt: subagent.lastActivityAt,
      integrationStatus: subagent.integrationStatus,
    })),
    recentEvents: ledgerEvents.slice(-20).map((event) => ({
      at: event.at,
      type: event.type,
      summary: summarizeLedgerEvent(event),
      nodeId: stringDetail(event.details, "nodeId"),
      subagentId: stringDetail(event.details, "subagentId"),
    })),
  };
}

export function formatGoalDebugReport(report: GoalDebugReport): string {
  const lines = [
    `Goal debug report ${report.goal.shortGoalId}`,
    `Status: ${report.goal.status}${report.goal.activityState ? ` · ${report.goal.activityState}` : ""}`,
    `Trace: ${report.traceTarget ?? "disabled (set GOAL_RUNNER_DEBUG_TRACE=1)"}`,
    `Counts: nodes=${report.counts.nodes}, subagents=${report.counts.subagents}, ledger=${report.counts.ledgerEvents}`,
    `Node statuses: ${formatCounts(report.counts.nodeStatuses)}`,
    `Subagent statuses: ${formatCounts(report.counts.subagentStatuses)}`,
  ];
  if (report.goal.executionWorkspace) lines.push(`Workspace: ${report.goal.executionWorkspace}`);
  if (report.goal.sessionFile) lines.push(`Session: ${report.goal.sessionFile}`);
  lines.push("");
  if (report.anomalies.length === 0) {
    lines.push("Anomalies: none detected");
  } else {
    lines.push(`Anomalies (${report.anomalies.length}):`);
    for (const anomaly of report.anomalies) {
      const target = [anomaly.nodeId, anomaly.subagentId].filter(Boolean).join("/");
      lines.push(`- [${anomaly.severity}] ${anomaly.code}${target ? ` ${target}` : ""}: ${anomaly.summary}`);
    }
  }
  lines.push("");
  lines.push("Nodes:");
  for (const node of report.nodes) {
    const launch = node.launchFailureCount ? ` launchFailures=${node.launchFailureCount}` : "";
    lines.push(`- ${node.nodeId}: ${node.status}${node.lifecyclePhase ? `/${node.lifecyclePhase}` : ""}${launch}`);
  }
  if (report.subagents.length) {
    lines.push("");
    lines.push("Subagents:");
    for (const subagent of report.subagents.slice(-20)) {
      lines.push(`- ${subagent.subagentId} (${subagent.nodeId}): ${subagent.status}${subagent.integrationState ? ` integration=${subagent.integrationState}` : ""}${subagent.retryCount ? ` retries=${subagent.retryCount}` : ""}`);
    }
  }
  if (report.recentEvents.length) {
    lines.push("");
    lines.push("Recent events:");
    for (const event of report.recentEvents.slice(-8)) {
      lines.push(`- ${event.at} ${event.type}${event.summary ? ` — ${event.summary}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function detectGoalDebugAnomalies(input: {
  goal: GoalSummary | GoalRecord;
  state: GoalOrchestrationState;
  ledgerEvents?: GoalLedgerEvent[];
  harnessState?: HarnessState;
  reservation?: ContinuationReservation;
  now?: Date;
}): GoalDebugAnomaly[] {
  const goal = normalizeGoalDebugGoal(input.goal);
  const anomalies: GoalDebugAnomaly[] = [];
  const subagentsByNode = groupSubagentsByNode(input.state.subagents);

  if (goal.status === "active" && input.state.nodes.length > 0 && input.state.nodes.every((node) => isTerminalNodeStatus(node.status))) {
    anomalies.push({
      code: "terminal-dag-not-finalized",
      severity: "warn",
      goalId: goal.goalId,
      summary: "goal is still active even though every DAG node is terminal",
    });
  }

  for (const issue of findRequiredSubagentIntegrationIssues(input.state)) {
    anomalies.push({
      code: "required-integration-incomplete",
      severity: "error",
      goalId: goal.goalId,
      nodeId: issue.nodeId,
      subagentId: issue.subagentId,
      summary: issue.reason,
    });
  }

  for (const node of input.state.nodes) {
    const nodeSubagents = subagentsByNode.get(node.nodeId) ?? [];
    const latest = latestSubagent(nodeSubagents);
    const launchFailures = runnerLaunchFailureCount(node) ?? 0;
    if (node.status === "running" && node.lifecyclePhase === "runnerStarting" && launchFailures > 0) {
      anomalies.push({
        code: "runner-launch-failure-retry-pending",
        severity: "warn",
        goalId: goal.goalId,
        nodeId: node.nodeId,
        subagentId: node.preparedResources?.subagentId,
        summary: `runner launch failed ${launchFailures} time(s); controller should retry after launch retry delay`,
        details: { lastRunnerLaunchFailureAt: node.preparedResources?.metadata?.lastRunnerLaunchFailureAt },
      });
    }
    if (node.status === "running" && node.lifecyclePhase === "runnerStarting" && !nodeSubagents.some((subagent) => isNonTerminalSubagentStatus(subagent.status))) {
      anomalies.push({
        code: "runner-starting-without-live-subagent",
        severity: launchFailures > 0 ? "warn" : "error",
        goalId: goal.goalId,
        nodeId: node.nodeId,
        subagentId: node.preparedResources?.subagentId,
        summary: "node is in runnerStarting but no non-terminal subagent record exists",
      });
    }
    if (node.status === "complete" && latest && latest.status !== "complete" && latest.status !== "blockedTerminal") {
      anomalies.push({
        code: "node-complete-subagent-not-complete",
        severity: "warn",
        goalId: goal.goalId,
        nodeId: node.nodeId,
        subagentId: latest.subagentId,
        summary: `node is complete while latest subagent is ${latest.status}`,
      });
    }
    if (node.status === "blocked" || node.status === "failed" || node.status === "blockedTerminal") {
      anomalies.push({
        code: `node-${node.status}`,
        severity: node.status === "failed" ? "error" : "warn",
        goalId: goal.goalId,
        nodeId: node.nodeId,
        summary: node.lastValidationSummary ?? `node status is ${node.status}`,
      });
    }
  }

  for (const subagent of input.state.subagents) {
    if ((subagent.status === "sessionStarted" || subagent.status === "running" || subagent.status === "idle") && !subagent.sessionId && !subagent.sessionFile) {
      anomalies.push({
        code: "active-subagent-missing-session-identity",
        severity: "warn",
        goalId: goal.goalId,
        nodeId: subagent.nodeId,
        subagentId: subagent.subagentId,
        summary: "active subagent has neither sessionId nor sessionFile",
      });
    }
    if (subagent.status === "blocked" || subagent.status === "blockedTerminal" || subagent.status === "failed") {
      anomalies.push({
        code: `subagent-${subagent.status}`,
        severity: subagent.status === "failed" ? "error" : "warn",
        goalId: goal.goalId,
        nodeId: subagent.nodeId,
        subagentId: subagent.subagentId,
        summary: subagent.integrationStatus ?? subagent.selfReportedResult ?? `subagent status is ${subagent.status}`,
      });
    }
    if (subagent.integrationState === "failed") {
      anomalies.push({
        code: "subagent-integration-failed",
        severity: "error",
        goalId: goal.goalId,
        nodeId: subagent.nodeId,
        subagentId: subagent.subagentId,
        summary: subagent.integrationError ?? subagent.integrationStatus ?? "subagent integration failed",
      });
    }
  }

  return dedupeAnomalies(anomalies);
}

export function recordGoalDebugSnapshot(
  tracer: GoalDebugTracer | undefined,
  input: {
    source: string;
    goal: GoalSummary | GoalRecord;
    state: GoalOrchestrationState;
    ledgerEvents?: GoalLedgerEvent[];
    harnessState?: HarnessState;
    reservation?: ContinuationReservation;
    now?: Date;
    details?: Record<string, unknown>;
  },
): void {
  if (!tracer?.enabled) return;
  const report = buildGoalDebugReport({
    goal: input.goal,
    state: input.state,
    ledgerEvents: input.ledgerEvents,
    harnessState: input.harnessState,
    reservation: input.reservation,
    traceTarget: tracer.getTraceTarget?.(),
    now: input.now,
  });
  tracer.record({
    category: "monitor",
    operation: "snapshot",
    severity: report.anomalies.some((anomaly) => anomaly.severity === "error") ? "error" : report.anomalies.length ? "warn" : "info",
    ok: true,
    sessionKey: report.goal.sessionKey,
    goalId: report.goal.goalId,
    summary: `${input.source}: ${report.counts.nodes} node(s), ${report.counts.subagents} subagent(s), ${report.anomalies.length} anomal(y/ies)`,
    details: {
      source: input.source,
      counts: report.counts,
      anomalies: report.anomalies.map((anomaly) => ({ code: anomaly.code, severity: anomaly.severity, nodeId: anomaly.nodeId, subagentId: anomaly.subagentId })),
      ...input.details,
    },
  });
  for (const anomaly of report.anomalies) {
    tracer.record({
      category: "anomaly",
      operation: anomaly.code,
      severity: anomaly.severity,
      ok: false,
      sessionKey: report.goal.sessionKey,
      goalId: anomaly.goalId,
      nodeId: anomaly.nodeId,
      subagentId: anomaly.subagentId,
      summary: anomaly.summary,
      details: { source: input.source, ...anomaly.details },
    });
  }
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isFalseyEnv(value: string): boolean {
  return ["0", "false", "off", "no", "disabled"].includes(value.trim().toLowerCase());
}

function goalContext(goal: GoalRecord): Partial<GoalDebugTraceEventInput> {
  return {
    sessionKey: goal.sessionKey,
    goalId: goal.goalId,
    details: {
      status: goal.status,
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget,
      timeUsedSeconds: goal.timeUsedSeconds,
      goalTurnsSinceAuditReset: goal.goalTurnsSinceAuditReset,
    },
  };
}

function nodeContext(node: GoalDagNode): Partial<GoalDebugTraceEventInput> {
  return {
    goalId: node.goalId,
    nodeId: node.nodeId,
    subagentId: node.preparedResources?.subagentId,
    details: {
      status: node.status,
      lifecyclePhase: node.lifecyclePhase,
      dependencyCount: node.dependencyNodeIds.length,
      expectedOutputCount: node.expectedOutputs.length,
      validatorCount: node.validators.length,
      launchFailureCount: runnerLaunchFailureCount(node),
    },
  };
}

function subagentContext(subagent: GoalSubagentRecord): Partial<GoalDebugTraceEventInput> {
  return {
    goalId: subagent.goalId,
    nodeId: subagent.nodeId,
    subagentId: subagent.subagentId,
    details: {
      status: subagent.status,
      hasSessionFile: Boolean(subagent.sessionFile),
      hasWorkspace: Boolean(subagent.workspacePath),
      integrationState: subagent.integrationState,
      retryCount: subagent.retryCount,
    },
  };
}

function summarizeGoalRecord(goal: GoalRecord | undefined): Record<string, unknown> {
  return goal ? { result: "found", goalId: goal.goalId, status: goal.status, tokensUsed: goal.tokensUsed } : { result: "none" };
}

function summarizeReservation(reservation: ContinuationReservation | undefined): Record<string, unknown> {
  return reservation ? { result: "found", goalId: reservation.goalId, status: reservation.status, attemptCount: reservation.attemptCount } : { result: "none" };
}

function summarizeLedgerEvents(events: GoalLedgerEvent[]): Record<string, unknown> {
  return { count: events.length, types: countBy(events.map((event) => event.type)) };
}

function summarizeNode(node: GoalDagNode | undefined): Record<string, unknown> {
  return node ? { result: "found", status: node.status, lifecyclePhase: node.lifecyclePhase } : { result: "none" };
}

function summarizeNodes(nodes: GoalDagNode[]): Record<string, unknown> {
  return { count: nodes.length, statuses: countBy(nodes.map((node) => node.status)) };
}

function summarizeSubagent(subagent: GoalSubagentRecord | undefined): Record<string, unknown> {
  return subagent ? { result: "found", status: subagent.status, nodeId: subagent.nodeId, integrationState: subagent.integrationState } : { result: "none" };
}

function summarizeSubagents(subagents: GoalSubagentRecord[]): Record<string, unknown> {
  return { count: subagents.length, statuses: countBy(subagents.map((subagent) => subagent.status)) };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function mergeDetails(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!left && !right) return undefined;
  return { ...(left ?? {}), ...(right ?? {}) };
}

function normalizeGoalDebugGoal(goal: GoalSummary | GoalRecord): GoalDebugReport["goal"] {
  const shortGoalId = "shortGoalId" in goal ? goal.shortGoalId : goal.goalId.slice(0, 8);
  const objectiveSummary = "objectiveSummary" in goal ? goal.objectiveSummary : summarizeObjective(goal.objective);
  return {
    goalId: goal.goalId,
    shortGoalId,
    sessionKey: goal.sessionKey,
    status: goal.status,
    activityState: "activityState" in goal ? goal.activityState : undefined,
    objectiveSummary,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    timeUsedSeconds: goal.timeUsedSeconds,
    executionWorkspace: "executionWorkspace" in goal ? goal.executionWorkspace : undefined,
    sessionFile: "sessionFile" in goal ? goal.sessionFile : undefined,
    updatedAt: goal.updatedAt,
  };
}

function summarizeObjective(objective: string): string {
  const normalized = objective.replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function runnerLaunchFailureCount(node: GoalDagNode): number | undefined {
  const value = node.preparedResources?.metadata?.runnerLaunchFailureCount;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function groupSubagentsByNode(subagents: GoalSubagentRecord[]): Map<string, GoalSubagentRecord[]> {
  const grouped = new Map<string, GoalSubagentRecord[]>();
  for (const subagent of subagents) {
    const bucket = grouped.get(subagent.nodeId) ?? [];
    bucket.push(subagent);
    grouped.set(subagent.nodeId, bucket);
  }
  return grouped;
}

function latestSubagent(subagents: GoalSubagentRecord[]): GoalSubagentRecord | undefined {
  return [...subagents].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0];
}

function isTerminalNodeStatus(status: GoalDagNode["status"]): boolean {
  return status === "complete" || status === "blocked" || status === "blockedTerminal" || status === "failed" || status === "superseded";
}

function isNonTerminalSubagentStatus(status: GoalSubagentRecord["status"]): boolean {
  return status === "planned" || status === "workspaceCreated" || status === "sessionStarted" || status === "running" || status === "idle" || status === "selfReportedComplete" || status === "controllerValidating" || status === "needsFollowup";
}

function dedupeAnomalies(anomalies: GoalDebugAnomaly[]): GoalDebugAnomaly[] {
  const seen = new Set<string>();
  const result: GoalDebugAnomaly[] = [];
  for (const anomaly of anomalies) {
    const key = `${anomaly.code}:${anomaly.nodeId ?? ""}:${anomaly.subagentId ?? ""}:${anomaly.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(anomaly);
  }
  return result;
}

function summarizeLedgerEvent(event: GoalLedgerEvent): string | undefined {
  const details = event.details;
  if (!details) return undefined;
  const summary = details.summary;
  if (typeof summary === "string") return truncate(summary, 160);
  const reason = details.reason;
  if (typeof reason === "string") return truncate(reason, 160);
  const error = details.error;
  if (typeof error === "string") return truncate(error, 160);
  return undefined;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" ? value : undefined;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function sanitizeDebugDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const sanitized = sanitizeValue(details, 0);
  return isPlainRecord(sanitized) ? sanitized : undefined;
}

function sanitizeValue(value: unknown, depth: number, key = ""): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (shouldRedactKey(key)) return `[redacted ${value.length} chars]`;
    return truncate(value, 1000);
  }
  if (depth >= 5) return "[max-depth]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1, key));
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 60)) {
      const sanitized = sanitizeValue(entryValue, depth + 1, entryKey);
      if (sanitized !== undefined) result[entryKey] = sanitized;
    }
    return result;
  }
  return String(value);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("prompt") || normalized.includes("objective") || normalized.includes("content") || normalized.includes("message");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function dropUndefined(record: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
