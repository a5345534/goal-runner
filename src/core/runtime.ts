import { randomUUID } from "node:crypto";
import {
  runGoalControllerLoop as runGoalControllerLoopCore,
  runGoalControllerTick as runGoalControllerTickCore,
  type GoalControllerLoopOptions,
  type GoalControllerLoopResult,
  type GoalControllerTickOptions,
  type GoalControllerTickResult,
} from "./controller-loop.js";
import {
  createGoalDagNodesFromObjective,
  type GoalDagObjectivePlanOptions,
  type GoalDagPlannedNodesResult,
} from "./dag-planner.js";
import { createGoalDagNodesFromFileDocument, type GoalDagFileDocument, type GoalDagFilePlanOptions } from "./dag-file.js";
import {
  createGoalDagNodes,
  getGoalDagReadyQueue as computeGoalDagReadyQueue,
  type GoalDagPlanNodeInput,
  type GoalDagPlanOptions,
  type GoalDagReadyQueue,
  type GoalDagSchedulingPolicy,
} from "./dag-scheduler.js";
import {
  instrumentGoalStore,
  recordGoalDebugSnapshot,
  type GoalDebugTraceEventInput,
  type GoalDebugTracer,
} from "./debug-trace.js";
import { findRequiredSubagentIntegrationIssues } from "./integration.js";
import { attachPreparedResourcesToNode, withGoalDagNodeLifecyclePhase } from "./lifecycle.js";
import { parseGoalCommand, validateGoalObjective, type GoalCommand } from "./parser.js";
import { renderBudgetLimitPrompt, renderContinuationPrompt, renderObjectiveUpdatedPrompt } from "./prompts.js";
import { isAutoContinuableStatus, normalizeGoalStatus } from "./status.js";
import {
  sendGoalSubagentPrompt as sendGoalSubagentPromptThroughAdapter,
  startGoalSubagent as startGoalSubagentThroughAdapter,
  syncGoalSubagentState,
  type HarnessSubagentAdapter,
  type StartGoalSubagentOptions,
} from "./subagent-adapter.js";
import type {
  BlockedAuditEvidence,
  CompletionAuditResult,
  ContinuationReservation,
  GoalAdapterCallbacks,
  GoalDagNode,
  GoalLedgerEvent,
  GoalLedgerEventType,
  GoalOrchestrationState,
  GoalRecord,
  GoalReferenceResolution,
  GoalRuntimeConfig,
  GoalSessionMetadata,
  GoalStatusInput,
  GoalNodePreparedResources,
  GoalStore,
  GoalSubagentRecord,
  GoalSummary,
  GoalToolResult,
  WorkspaceProfile,
  GoalTurnStop,
  GoalTurnStopReason,
  HarnessState,
  HiddenGoalTurnResult,
  TokenUsageSnapshot,
  TurnContext,
} from "./types.js";

interface ActiveTurnState {
  turnId?: string;
  sessionKey: string;
  startedAt: Date;
  lastTokenTotal?: number;
  madeMeaningfulProgress: boolean;
  stopped?: GoalTurnStop;
}

export interface GoalDagTerminalFinalizationResult {
  goalId: string;
  terminal: boolean;
  changed: boolean;
  reason: string;
  status?: GoalRecord["status"];
  goal?: GoalRecord;
}

const TERMINAL_DAG_NODE_STATUSES = new Set<GoalDagNode["status"]>(["complete", "blocked", "blockedTerminal", "failed", "superseded"]);

export class GoalRuntime {
  private readonly store: GoalStore;
  private readonly callbacks: GoalAdapterCallbacks;
  private readonly debugTracer?: GoalDebugTracer;
  private readonly config: Required<GoalRuntimeConfig>;
  private readonly activeTurns = new Map<string, ActiveTurnState>();

  constructor(options: { store: GoalStore; callbacks?: GoalAdapterCallbacks; config?: GoalRuntimeConfig; debugTracer?: GoalDebugTracer }) {
    this.debugTracer = options.debugTracer;
    this.store = instrumentGoalStore(options.store, this.debugTracer);
    this.callbacks = options.callbacks ?? {};
    this.config = {
      defaultTokenBudget: options.config?.defaultTokenBudget ?? 200_000,
      blockedTurnsThreshold: options.config?.blockedTurnsThreshold ?? 3,
      maxContinuationAttempts: options.config?.maxContinuationAttempts ?? 3,
      continuationReservationTtlMs: options.config?.continuationReservationTtlMs ?? 5 * 60_000,
      retryBaseDelayMs: options.config?.retryBaseDelayMs ?? 250,
      retryJitterMs: options.config?.retryJitterMs ?? 50,
      now: options.config?.now ?? (() => new Date()),
      randomId: options.config?.randomId ?? (() => randomUUID()),
    };
  }

  async executeCommand(sessionKey: string, args: string, options: { editObjective?: string; confirmReplace?: boolean } = {}): Promise<GoalToolResult> {
    const command = parseGoalCommand(args);
    return this.executeParsedCommand(sessionKey, command, options);
  }

  async executeParsedCommand(sessionKey: string, command: GoalCommand, options: { editObjective?: string; confirmReplace?: boolean } = {}): Promise<GoalToolResult> {
    switch (command.kind) {
      case "show":
        return this.getGoal(sessionKey);
      case "start":
        return this.createOrReplaceGoal(sessionKey, command.objective, {
          tokenBudget: command.tokenBudget,
          confirmReplace: options.confirmReplace ?? true,
        });
      case "edit": {
        const objective = options.editObjective ?? command.objective;
        if (objective === undefined) throw new Error("edit objective is required for /goal edit");
        return this.editGoal(sessionKey, objective, { tokenBudget: command.tokenBudget });
      }
      case "retryNode":
        return this.retryGoalDagNodeForSession(sessionKey, command.nodeId);
      case "continueNode":
        return this.continueGoalDagNodeInPlaceForSession(sessionKey, command.nodeId);
      case "continueSubagent":
        return this.continueGoalDagSubagentInPlaceForSession(sessionKey, command.subagentId);
      case "pause":
        return this.pauseGoal(sessionKey);
      case "resume":
        return this.resumeGoal(sessionKey);
      case "clear":
        return this.clearGoal(sessionKey);
    }
  }

  async getGoal(sessionKey: string): Promise<GoalToolResult> {
    const goal = await this.store.getCurrentGoal(sessionKey);
    return { goal, message: goal ? formatGoalSummary(goal) : "No current goal." };
  }

  async listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]> {
    return this.store.listLedgerEvents(sessionKey, goalId);
  }

  async recordControllerEvent(goalId: string, details: Record<string, unknown>, options: { at?: Date | string } = {}): Promise<void> {
    const goal = await this.getGoalById(goalId);
    if (!goal) return;
    const at = options.at === undefined ? this.config.now() : typeof options.at === "string" ? new Date(options.at) : options.at;
    await this.appendLedger("controller_event", goal.sessionKey, goalId, details, at);
  }

  async pruneLedgerEvents(goalId: string, options: { maxEvents: number }): Promise<number> {
    return this.store.pruneLedgerEvents?.(goalId, options) ?? 0;
  }

  // --- Controller audit port methods (GoalControllerRuntimePort) ---

  async getGoalRecord(goalId: string): Promise<GoalRecord> {
    const goal = await this.getGoalById(goalId);
    if (!goal) throw new Error(`goal not found: ${goalId}`);
    return goal;
  }

  async listGoalLedgerEvents(goalId: string): Promise<GoalLedgerEvent[]> {
    const goal = await this.getGoalById(goalId);
    if (!goal) return [];
    return this.store.listLedgerEvents(goal.sessionKey, goalId);
  }

  async auditPauseGoal(goalId: string, reason: string): Promise<void> {
    const goal = await this.getGoalById(goalId);
    if (!goal) throw new Error(`goal not found: ${goalId}`);
    const paused = await this.setGoalStatus(goal, "paused");
    await this.store.clearReservation(goal.sessionKey);
    await this.appendLedger("goal_paused", goal.sessionKey, paused.goalId, {
      source: "controller_audit",
      reason,
    });
  }

  async saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void> {
    await this.store.saveGoalSessionMetadata(metadata);
  }

  async listGoalSummaries(): Promise<GoalSummary[]> {
    return this.store.listGoalSummaries();
  }

  async getGoalById(goalId: string): Promise<GoalRecord | undefined> {
    const summary = (await this.store.listGoalSummaries()).find((goal) => goal.goalId === goalId);
    return summary ? this.store.getCurrentGoal(summary.sessionKey) : undefined;
  }

  async finalizeGoalFromDagTerminalState(goalId: string): Promise<GoalDagTerminalFinalizationResult> {
    const state = await this.getGoalOrchestrationState(goalId);
    if (state.nodes.length === 0) {
      return { goalId, terminal: false, changed: false, reason: "goal has no DAG nodes" };
    }

    const nonTerminal = state.nodes.filter((node) => !TERMINAL_DAG_NODE_STATUSES.has(node.status));
    if (nonTerminal.length > 0) {
      return {
        goalId,
        terminal: false,
        changed: false,
        reason: `non-terminal DAG nodes remain: ${nonTerminal.map((node) => `${node.nodeId}:${node.status}`).join(", ")}`,
      };
    }

    const integrationIssues = findRequiredSubagentIntegrationIssues(state);

    const goal = await this.getGoalById(goalId);
    if (!goal) return { goalId, terminal: true, changed: false, reason: "goal record not found" };
    if (goal.status !== "active") {
      return { goalId, terminal: true, changed: false, reason: `goal already ${goal.status}`, status: goal.status, goal };
    }

    const allComplete = state.nodes.every((node) => node.status === "complete" || node.status === "superseded");
    const nextStatus: GoalRecord["status"] = allComplete && integrationIssues.length === 0 ? "complete" : "blocked";
    const updated = await this.setGoalStatus(goal, nextStatus);
    await this.store.clearReservation(goal.sessionKey);
    await this.appendLedger(nextStatus === "complete" ? "goal_completed" : "goal_blocked", goal.sessionKey, updated.goalId, {
      source: "controller_dag_terminal_state",
      nodeStatuses: state.nodes.map((node) => ({
        nodeId: node.nodeId,
        status: node.status,
        validation: node.lastValidationSummary,
      })),
      subagentStatuses: state.subagents.map((subagent) => ({
        subagentId: subagent.subagentId,
        nodeId: subagent.nodeId,
        status: subagent.status,
        result: subagent.selfReportedResult,
        integrationStatus: subagent.integrationStatus,
        integrationState: subagent.integrationState,
        integrationCommitSha: subagent.integrationCommitSha,
        integrationError: subagent.integrationError,
      })),
      integrationIssues,
    });
    this.activeTurns.delete(goal.sessionKey);
    return {
      goalId,
      terminal: true,
      changed: true,
      reason: integrationIssues.length > 0
        ? `required subagent integration incomplete: ${integrationIssues.map((issue) => `${issue.nodeId}/${issue.subagentId}`).join(", ")}`
        : allComplete ? "all DAG nodes complete" : "one or more DAG nodes ended blocked/failed",
      status: updated.status,
      goal: updated,
    };
  }

  async blockGoalFromControllerCloseout(goalId: string, reason: string, details: Record<string, unknown> = {}): Promise<GoalDagTerminalFinalizationResult> {
    const goal = await this.getGoalById(goalId);
    if (!goal) return { goalId, terminal: true, changed: false, reason: "goal record not found" };
    if (goal.status !== "active") {
      return { goalId, terminal: true, changed: false, reason: `goal already ${goal.status}`, status: goal.status, goal };
    }

    const updated = await this.setGoalStatus(goal, "blocked");
    await this.store.clearReservation(goal.sessionKey);
    await this.appendLedger("goal_blocked", goal.sessionKey, updated.goalId, {
      source: "controller_closeout",
      reason,
      ...details,
    });
    this.activeTurns.delete(goal.sessionKey);
    return { goalId, terminal: true, changed: true, reason, status: updated.status, goal: updated };
  }

  async saveGoalDagNode(node: GoalDagNode): Promise<void> {
    await this.store.saveGoalDagNode(node);
  }

  async getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined> {
    return this.store.getGoalDagNode(goalId, nodeId);
  }

  async listGoalDagNodes(goalId: string): Promise<GoalDagNode[]> {
    return this.store.listGoalDagNodes(goalId);
  }

  async saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void> {
    await this.store.saveGoalSubagent(subagent);
  }

  async getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined> {
    return this.store.getGoalSubagent(goalId, subagentId);
  }

  async listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]> {
    return this.store.listGoalSubagents(goalId, nodeId);
  }

  async getGoalOrchestrationState(goalId: string): Promise<GoalOrchestrationState> {
    const [nodes, subagents] = await Promise.all([
      this.store.listGoalDagNodes(goalId),
      this.store.listGoalSubagents(goalId),
    ]);
    return { goalId, nodes, subagents };
  }

  async planGoalDag(goalId: string, inputs: GoalDagPlanNodeInput[], options: GoalDagPlanOptions = {}): Promise<GoalDagNode[]> {
    const nodes = createGoalDagNodes(goalId, inputs, options);
    for (const node of nodes) await this.store.saveGoalDagNode(node);
    return nodes;
  }

  async planGoalDagFromObjective(
    goalId: string,
    objective: string,
    options: GoalDagObjectivePlanOptions = {},
  ): Promise<GoalDagPlannedNodesResult> {
    const plan = createGoalDagNodesFromObjective(goalId, objective, options);
    for (const node of plan.nodes) await this.store.saveGoalDagNode(node);
    return plan;
  }

  async planGoalDagFromFileDocument(
    goalId: string,
    document: GoalDagFileDocument,
    options: GoalDagFilePlanOptions = {},
  ): Promise<GoalDagPlannedNodesResult> {
    const plan = createGoalDagNodesFromFileDocument(goalId, document, options);
    for (const node of plan.nodes) await this.store.saveGoalDagNode(node);
    return plan;
  }

  async getGoalDagReadyQueue(goalId: string, policy: GoalDagSchedulingPolicy = {}): Promise<GoalDagReadyQueue> {
    return computeGoalDagReadyQueue(await this.getGoalOrchestrationState(goalId), policy);
  }

  async startGoalSubagent(
    adapter: HarnessSubagentAdapter,
    node: GoalDagNode,
    options: StartGoalSubagentOptions,
  ): Promise<GoalSubagentRecord> {
    const { record } = await startGoalSubagentThroughAdapter(adapter, node, options);
    const preparedResources: GoalNodePreparedResources = {
      ...(options.preparedResources ?? {}),
      subagentId: record.subagentId,
      adapterId: adapter.adapterId,
      workspacePath: record.workspacePath ?? options.cwd ?? options.preparedResources?.workspacePath,
      branch: record.branch ?? options.branch ?? options.preparedResources?.branch,
      ref: record.ref ?? options.ref ?? options.preparedResources?.ref,
      sessionId: record.sessionId ?? options.preparedResources?.sessionId,
      sessionFile: record.sessionFile ?? options.preparedResources?.sessionFile,
      modelArg: typeof options.metadata?.modelArg === "string" ? options.metadata.modelArg : options.preparedResources?.modelArg,
      modelScenario: typeof options.metadata?.modelScenario === "string" ? options.metadata.modelScenario : options.preparedResources?.modelScenario,
      thinkingLevel: options.thinkingLevel ?? options.preparedResources?.thinkingLevel,
      updatedAt: record.updatedAt,
      createdAt: options.preparedResources?.createdAt ?? record.createdAt,
    };
    await this.store.saveGoalSubagent(record);
    const runningNode = withGoalDagNodeLifecyclePhase(
      attachPreparedResourcesToNode(node, preparedResources, { phase: "runnerActive", now: record.updatedAt }),
      "runnerActive",
      { status: "running", now: record.updatedAt },
    );
    await this.store.saveGoalDagNode(runningNode);
    return record;
  }

  async sendGoalSubagentPrompt(
    adapter: HarnessSubagentAdapter,
    subagent: GoalSubagentRecord,
    prompt: string,
    options: { metadata?: Record<string, unknown>; now?: Date | string } = {},
  ): Promise<GoalSubagentRecord> {
    const updated = await sendGoalSubagentPromptThroughAdapter(adapter, subagent, prompt, options);
    await this.store.saveGoalSubagent(updated);
    return updated;
  }

  async syncGoalSubagent(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord): Promise<GoalSubagentRecord> {
    const updated = await syncGoalSubagentState(adapter, subagent, { now: this.config.now() });
    await this.store.saveGoalSubagent(updated);
    return updated;
  }

  async runGoalControllerTick(goalId: string, options: GoalControllerTickOptions): Promise<GoalControllerTickResult> {
    const startedAt = Date.now();
    try {
      const result = await runGoalControllerTickCore(this, goalId, { now: this.config.now, ...options });
      await this.recordDebugTrace({
        category: "controller",
        operation: "tick",
        severity: "debug",
        ok: true,
        durationMs: Date.now() - startedAt,
        goalId,
        details: {
          started: result.started.length,
          synced: result.synced.length,
          blocked: result.blocked.length,
          completed: result.completed.length,
          failed: result.failed.length,
          followups: result.followups.length,
          ready: result.ready.length,
          queueBlocked: result.queueBlocked.length,
          changed: result.changed,
        },
      });
      await this.recordGoalDebugSnapshot(goalId, "controller.tick", { tickResult: { started: result.started.length, synced: result.synced.length, blocked: result.blocked.length, completed: result.completed.length, followups: result.followups.length } });
      return result;
    } catch (error) {
      await this.recordDebugTrace({
        category: "controller",
        operation: "tick",
        severity: "error",
        ok: false,
        durationMs: Date.now() - startedAt,
        goalId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async runGoalControllerLoop(goalId: string, options: GoalControllerLoopOptions): Promise<GoalControllerLoopResult> {
    const startedAt = Date.now();
    try {
      const result = await runGoalControllerLoopCore(this, goalId, { now: this.config.now, ...options });
      await this.recordDebugTrace({
        category: "controller",
        operation: "loop",
        severity: "debug",
        ok: true,
        durationMs: Date.now() - startedAt,
        goalId,
        details: { goalId: result.goalId, ticks: result.ticks.length, changedTicks: result.ticks.filter((tick) => tick.changed).length },
      });
      await this.recordGoalDebugSnapshot(goalId, "controller.loop", { loopResult: result });
      return result;
    } catch (error) {
      await this.recordDebugTrace({
        category: "controller",
        operation: "loop",
        severity: "error",
        ok: false,
        durationMs: Date.now() - startedAt,
        goalId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getDebugTraceTarget(): string | undefined {
    return this.debugTracer?.getTraceTarget?.();
  }

  async recordDebugTrace(event: GoalDebugTraceEventInput): Promise<void> {
    if (!this.debugTracer?.enabled) return;
    await this.debugTracer.record(event);
  }

  async recordMonitorDebugSnapshot(
    goal: GoalSummary | GoalRecord,
    state: GoalOrchestrationState,
    options: { source: string; ledgerEvents?: GoalLedgerEvent[]; harnessState?: HarnessState; reservation?: ContinuationReservation; details?: Record<string, unknown> } = { source: "monitor" },
  ): Promise<void> {
    recordGoalDebugSnapshot(this.debugTracer, { goal, state, source: options.source, ledgerEvents: options.ledgerEvents, harnessState: options.harnessState, reservation: options.reservation, details: options.details });
  }

  private async recordGoalDebugSnapshot(goalId: string, source: string, details?: Record<string, unknown>): Promise<void> {
    if (!this.debugTracer?.enabled) return;
    const goal = await this.getGoalById(goalId);
    if (!goal) return;
    const state = await this.getGoalOrchestrationState(goalId);
    const ledgerEvents = await this.store.listLedgerEvents(goal.sessionKey, goalId);
    recordGoalDebugSnapshot(this.debugTracer, { goal, state, ledgerEvents, source, details });
  }

  async resolveGoalReference(reference: string): Promise<GoalReferenceResolution> {
    const trimmed = reference.trim();
    const summaries = await this.store.listGoalSummaries();
    const matches = summaries.filter((goal) => goal.goalId === trimmed || goal.goalId.startsWith(trimmed));
    if (matches.length === 1) return { kind: "found", goal: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", reference: trimmed, matches };
    return { kind: "notFound", reference: trimmed };
  }

  async saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void> {
    await this.store.saveWorkspaceProfile(profile);
  }

  async getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined> {
    return this.store.getWorkspaceProfile(name);
  }

  async listWorkspaceProfiles(): Promise<WorkspaceProfile[]> {
    return this.store.listWorkspaceProfiles();
  }

  async deleteWorkspaceProfile(name: string): Promise<boolean> {
    return this.store.deleteWorkspaceProfile(name);
  }

  getCurrentTurnStop(sessionKey: string): GoalTurnStop | undefined {
    const stop = this.activeTurns.get(sessionKey)?.stopped;
    return stop ? { ...stop } : undefined;
  }

  async createOrReplaceGoal(
    sessionKey: string,
    objectiveInput: string,
    options: { tokenBudget?: number; confirmReplace?: boolean; continueIfIdle?: boolean } = {},
  ): Promise<GoalToolResult> {
    const objective = validateGoalObjective(objectiveInput);
    const now = this.nowIso();
    const existing = await this.store.getCurrentGoal(sessionKey);

    if (existing && options.confirmReplace === false) {
      throw new Error("a current goal already exists; replacement was not confirmed");
    }

    const goal: GoalRecord = existing
      ? {
          ...existing,
          objective,
          status: "active",
          tokenBudget: options.tokenBudget ?? existing.tokenBudget,
          updatedAt: now,
          goalTurnsSinceAuditReset: 0,
        }
      : {
          sessionKey,
          goalId: this.config.randomId(),
          objective,
          status: "active",
          tokenBudget: options.tokenBudget,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
          goalTurnsSinceAuditReset: 0,
        };

    await this.store.saveGoal(goal);
    await this.appendLedger(existing ? "goal_replaced" : "goal_created", sessionKey, goal.goalId, {
      objective,
      tokenBudget: goal.tokenBudget,
      previousGoalId: existing?.goalId,
    });
    await this.store.clearReservation(sessionKey);
    await this.callbacks.notifyGoalUpdated?.(goal);
    if (options.continueIfIdle !== false) await this.maybeContinueIfIdle(sessionKey);
    return { goal, message: existing ? "Goal updated." : "Goal created." };
  }

  async editGoal(
    sessionKey: string,
    objectiveInput: string,
    options: { tokenBudget?: number } = {},
  ): Promise<GoalToolResult> {
    await this.requireGoal(sessionKey);
    await this.accountUsage(sessionKey);
    const accounted = await this.requireGoal(sessionKey);
    const nextTokenBudget = options.tokenBudget ?? accounted.tokenBudget;
    const updated = normalizeBudgetLimited({
      ...accounted,
      objective: validateGoalObjective(objectiveInput),
      status: "active",
      tokenBudget: nextTokenBudget,
      updatedAt: this.nowIso(),
      goalTurnsSinceAuditReset: 0,
    });
    await this.store.saveGoal(updated);
    await this.appendLedger("goal_edited", sessionKey, updated.goalId, {
      objective: updated.objective,
      tokenBudget: updated.tokenBudget,
      status: updated.status,
    });
    await this.store.clearReservation(sessionKey);
    await this.callbacks.notifyGoalUpdated?.(updated);
    await this.callbacks.injectSteeringContext?.({
      sessionKey,
      goalId: updated.goalId,
      kind: "objective_updated",
      renderedPrompt: renderObjectiveUpdatedPrompt(updated),
    });
    await this.maybeContinueIfIdle(sessionKey);
    return { goal: updated, message: "Goal objective updated." };
  }

  async pauseGoal(sessionKey: string): Promise<GoalToolResult> {
    const goal = await this.requireGoal(sessionKey);
    await this.accountUsage(sessionKey);
    const updated = await this.setGoalStatus(goal, "paused");
    await this.appendLedger("goal_paused", sessionKey, updated.goalId);
    await this.store.clearReservation(sessionKey);
    this.markTurnStopped(sessionKey, "pause", updated.goalId, "Goal paused.");
    return { goal: updated, message: "Goal paused." };
  }

  async resumeGoal(sessionKey: string, options: { continueIfIdle?: boolean } = {}): Promise<GoalToolResult> {
    await this.requireGoal(sessionKey);
    await this.accountUsage(sessionKey);
    const accounted = await this.requireGoal(sessionKey);
    const updated = normalizeBudgetLimited({
      ...accounted,
      status: "active",
      updatedAt: this.nowIso(),
      goalTurnsSinceAuditReset: accounted.status === "blocked" ? 0 : accounted.goalTurnsSinceAuditReset,
    });
    await this.store.saveGoal(updated);
    await this.appendLedger("goal_resumed", sessionKey, updated.goalId, { status: updated.status });
    await this.store.clearReservation(sessionKey);
    await this.callbacks.notifyGoalUpdated?.(updated);
    if (options.continueIfIdle !== false) await this.maybeContinueIfIdle(sessionKey);
    return {
      goal: updated,
      message: updated.status === "budgetLimited" ? "Goal token budget is still exhausted." : "Goal resumed.",
    };
  }

  async retryGoalDagNodeForSession(sessionKey: string, nodeId: string): Promise<GoalToolResult> {
    const goal = await this.requireGoal(sessionKey);
    return this.retryGoalDagNode(goal.goalId, nodeId);
  }

  async retryGoalDagNode(goalId: string, nodeId: string): Promise<GoalToolResult> {
    const goal = await this.getGoalById(goalId);
    if (!goal) throw new Error(`goal not found: ${goalId}`);
    const node = await this.store.getGoalDagNode(goalId, nodeId);
    if (!node) throw new Error(`DAG node not found for goal ${goalId}: ${nodeId}`);
    if (!["blocked", "blockedTerminal", "failed", "needsFollowup"].includes(node.status)) {
      throw new Error(`DAG node ${nodeId} is ${node.status}; only blocked, blockedTerminal, failed, or needsFollowup nodes can be retried`);
    }

    const now = this.nowIso();
    const subagents = await this.store.listGoalSubagents(goalId, nodeId);
    const retiredSubagentIds: string[] = [];
    for (const subagent of subagents) {
      if (subagent.status === "complete") continue;
      await this.store.saveGoalSubagent({
        ...subagent,
        status: "blockedTerminal",
        integrationState: undefined,
        integrationSourceBranch: undefined,
        integrationSourceRef: undefined,
        integrationSourceHead: undefined,
        integrationCommitSha: undefined,
        integrationError: undefined,
        integrationCompletedAt: undefined,
        integrationStatus: appendRetryNote(subagent.integrationStatus, `superseded by manual node retry at ${now}`),
        updatedAt: now,
      });
      retiredSubagentIds.push(subagent.subagentId);
    }

    const retriedNode: GoalDagNode = {
      ...node,
      workspace: retryWorkspaceForNode(node, subagents),
      status: "planned",
      lifecyclePhase: undefined,
      preparedResources: undefined,
      lastAdapterObservation: undefined,
      lastRecoveryDecision: undefined,
      lastValidationSummary: `manual retry requested for ${node.status} node at ${now}`,
      updatedAt: now,
    };
    await this.store.saveGoalDagNode(retriedNode);

    const updatedGoal = goal.status === "active"
      ? { ...goal, updatedAt: now }
      : normalizeBudgetLimited({
        ...goal,
        status: "active",
        updatedAt: now,
        goalTurnsSinceAuditReset: goal.status === "blocked" ? 0 : goal.goalTurnsSinceAuditReset,
      });
    await this.store.saveGoal(updatedGoal);
    await this.appendLedger("goal_node_retry_requested", goal.sessionKey, goalId, {
      nodeId,
      previousStatus: node.status,
      previousLifecyclePhase: node.lifecyclePhase,
      previousSummary: node.lastValidationSummary,
      retiredSubagentIds,
    });
    await this.store.clearReservation(goal.sessionKey);
    await this.callbacks.notifyGoalUpdated?.(updatedGoal);
    return { goal: updatedGoal, message: `DAG node ${nodeId} reset to planned for retry.` };
  }

  async continueGoalDagNodeInPlaceForSession(sessionKey: string, nodeId: string): Promise<GoalToolResult> {
    const goal = await this.requireGoal(sessionKey);
    return this.continueGoalDagNodeInPlace(goal.goalId, nodeId);
  }

  async continueGoalDagSubagentInPlaceForSession(sessionKey: string, subagentId: string): Promise<GoalToolResult> {
    const goal = await this.requireGoal(sessionKey);
    return this.continueGoalDagSubagentInPlace(goal.goalId, subagentId);
  }

  async continueGoalDagNodeInPlace(goalId: string, nodeId: string): Promise<GoalToolResult> {
    return this.continueGoalDagNodeInPlaceInternal(goalId, nodeId);
  }

  async continueGoalDagSubagentInPlace(goalId: string, subagentId: string): Promise<GoalToolResult> {
    const subagent = await this.store.getGoalSubagent(goalId, subagentId);
    if (!subagent) throw new Error(`subagent not found for goal ${goalId}: ${subagentId}`);
    return this.continueGoalDagNodeInPlaceInternal(goalId, subagent.nodeId, subagentId);
  }

  private async continueGoalDagNodeInPlaceInternal(goalId: string, nodeId: string, preferredSubagentId?: string): Promise<GoalToolResult> {
    const goal = await this.getGoalById(goalId);
    if (!goal) throw new Error(`goal not found: ${goalId}`);
    const node = await this.store.getGoalDagNode(goalId, nodeId);
    if (!node) throw new Error(`DAG node not found for goal ${goalId}: ${nodeId}`);
    if (!["blocked", "blockedTerminal", "failed", "needsFollowup"].includes(node.status)) {
      throw new Error(`DAG node ${nodeId} is ${node.status}; only blocked, blockedTerminal, failed, or needsFollowup nodes can be continued in-place`);
    }

    const subagents = await this.store.listGoalSubagents(goalId, nodeId);
    const subagent = selectSubagentForInPlaceContinuation(node, subagents, preferredSubagentId);
    if (!subagent) {
      const target = preferredSubagentId ? `subagent ${preferredSubagentId}` : `DAG node ${nodeId}`;
      throw new Error(`${target} has no recorded subagent to continue; use retry-node to start a fresh subagent`);
    }
    if (!subagent.sessionFile) throw new Error(`DAG node ${nodeId} subagent ${subagent.subagentId} has no reusable session file; use retry-node to start a fresh subagent`);

    const now = this.nowIso();
    const previousRetryCount = subagent.retryCount ?? 0;
    const resetSubagent: GoalSubagentRecord = {
      ...subagent,
      status: "blocked",
      integrationState: resetIntegrationStateForContinuation(subagent),
      integrationError: undefined,
      integrationCompletedAt: undefined,
      retryCount: 0,
      lastActionAttempt: undefined,
      lastAdapterObservation: undefined,
      lastRecoveryDecision: undefined,
      recoveryLoopSignature: undefined,
      integrationStatus: appendRetryNote(subagent.integrationStatus, `manual same-subagent continuation requested at ${now}; retry count reset from ${previousRetryCount} to 0`),
      updatedAt: now,
    };
    await this.store.saveGoalSubagent(resetSubagent);

    const continuedNode: GoalDagNode = {
      ...node,
      status: "blocked",
      lifecyclePhase: "controllerJudging",
      preparedResources: preparedResourcesForInPlaceContinuation(node, resetSubagent, now),
      lastAdapterObservation: undefined,
      lastRecoveryDecision: undefined,
      lastValidationSummary: `manual same-subagent continuation requested for ${node.status} node at ${now}; retry count reset from ${previousRetryCount} to 0`,
      updatedAt: now,
    };
    await this.store.saveGoalDagNode(continuedNode);

    const updatedGoal = goal.status === "active"
      ? { ...goal, updatedAt: now }
      : normalizeBudgetLimited({
        ...goal,
        status: "active",
        updatedAt: now,
        goalTurnsSinceAuditReset: goal.status === "blocked" ? 0 : goal.goalTurnsSinceAuditReset,
      });
    await this.store.saveGoal(updatedGoal);
    await this.appendLedger("goal_node_continue_requested", goal.sessionKey, goalId, {
      nodeId,
      subagentId: subagent.subagentId,
      previousNodeStatus: node.status,
      previousSubagentStatus: subagent.status,
      previousRetryCount,
      preservedSessionFile: subagent.sessionFile,
      preservedWorkspacePath: subagent.workspacePath,
    });
    await this.store.clearReservation(goal.sessionKey);
    await this.callbacks.notifyGoalUpdated?.(updatedGoal);
    return { goal: updatedGoal, message: `Subagent ${subagent.subagentId} queued for same-subagent continuation on DAG node ${nodeId}; retry count reset.` };
  }

  async getReservation(sessionKey: string): Promise<ContinuationReservation | undefined> {
    return this.store.getReservation(sessionKey);
  }

  async clearGoal(sessionKey: string): Promise<GoalToolResult> {
    const existing = await this.store.getCurrentGoal(sessionKey);
    await this.store.clearGoal(sessionKey);
    this.activeTurns.delete(sessionKey);
    await this.appendLedger("goal_cleared", sessionKey, existing?.goalId);
    await this.callbacks.notifyGoalCleared?.(sessionKey);
    return { message: "Goal cleared." };
  }

  async toolGetGoal(sessionKey: string): Promise<GoalToolResult> {
    return this.getGoal(sessionKey);
  }

  async toolCreateGoal(sessionKey: string, objective: string, tokenBudget?: number): Promise<GoalToolResult> {
    const existing = await this.store.getCurrentGoal(sessionKey);
    if (existing) throw new Error("a current goal already exists");
    return this.createOrReplaceGoal(sessionKey, objective, { tokenBudget, confirmReplace: false });
  }

  async toolUpdateGoal(
    sessionKey: string,
    statusInput: GoalStatusInput,
    options: { blockedAuditEvidence?: BlockedAuditEvidence } = {},
  ): Promise<GoalToolResult> {
    const status = normalizeGoalStatus(statusInput);
    if (status !== "complete" && status !== "blocked") {
      throw new Error("update_goal only accepts status complete or blocked");
    }
    await this.requireGoal(sessionKey);
    await this.accountUsage(sessionKey);
    const goal = await this.requireGoal(sessionKey);

    if (status === "blocked") {
      if (goal.goalTurnsSinceAuditReset < this.config.blockedTurnsThreshold) {
        throw new Error(
          `blocked requires the same blocker for at least ${this.config.blockedTurnsThreshold} consecutive goal turns`,
        );
      }
      const evidence = options.blockedAuditEvidence;
      if (evidence && evidence.consecutiveMatchingTurns < this.config.blockedTurnsThreshold) {
        const detail = evidence.reason ? `: ${evidence.reason}` : "";
        throw new Error(
          `blocked requires matching blocker evidence for at least ${this.config.blockedTurnsThreshold} consecutive goal turns${detail}`,
        );
      }
      const updated = await this.setGoalStatus(goal, "blocked");
      await this.appendLedger("goal_blocked", sessionKey, updated.goalId, { evidence });
      await this.store.clearReservation(sessionKey);
      this.markTurnStopped(sessionKey, "blocked", updated.goalId, "Goal marked blocked.");
      return { goal: updated, message: "Goal marked blocked." };
    }

    const audit = await this.runCompletionAuditIfConfigured(goal);
    if (audit && !audit.approved) {
      await this.store.clearReservation(sessionKey);
      const message = audit.summary || audit.report || "Completion audit did not approve the goal.";
      this.markTurnStopped(sessionKey, "completionRejected", goal.goalId, message);
      await this.callbacks.notifyGoalWarning?.(sessionKey, `Goal completion rejected: ${message}`);
      return { goal, message: `Goal completion rejected: ${message}` };
    }

    // Enforce DAG terminal state: refuse completion when orchestrated nodes are still in progress.
    const orchestrationState = await this.getGoalOrchestrationState(goal.goalId);
    if (orchestrationState.nodes.length > 0) {
      const nonTerminal = orchestrationState.nodes.filter((node) => !TERMINAL_DAG_NODE_STATUSES.has(node.status));
      if (nonTerminal.length > 0) {
        const remaining = nonTerminal.map((node) => `${node.nodeId}:${node.status}`).join(", ");
        throw new Error(
          `Goal cannot be completed: ${nonTerminal.length} DAG node(s) still non-terminal (${remaining}). ` +
          `All DAG nodes must reach complete, blocked, or failed before the goal can be marked complete.`,
        );
      }
      const unsuccessfulTerminal = orchestrationState.nodes.filter((node) => node.status === "blocked" || node.status === "failed");
      if (unsuccessfulTerminal.length > 0) {
        throw new Error(
          `Goal cannot be completed: ${unsuccessfulTerminal.length} DAG node(s) are blocked or failed ` +
          `(${unsuccessfulTerminal.map((node) => `${node.nodeId}:${node.status}`).join(", ")}). ` +
          `Resolve or supersede blocked/failed DAG nodes before marking the goal complete.`,
        );
      }
      const integrationIssues = findRequiredSubagentIntegrationIssues(orchestrationState);
      if (integrationIssues.length > 0) {
        throw new Error(
          `Goal cannot be completed: ${integrationIssues.length} required subagent integration(s) incomplete ` +
          `(${integrationIssues.map((issue) => `${issue.nodeId}/${issue.subagentId}: ${issue.reason}`).join("; ")}).`,
        );
      }
    }

    const updated = await this.setGoalStatus(goal, "complete");
    await this.appendLedger("goal_completed", sessionKey, updated.goalId, { audit });
    await this.store.clearReservation(sessionKey);
    const completionMessage = audit?.summary ? `Goal marked complete. Audit: ${audit.summary}` : "Goal marked complete.";
    this.markTurnStopped(sessionKey, "complete", updated.goalId, completionMessage);
    return { goal: updated, message: completionMessage };
  }

  async turnStarted(context: TurnContext): Promise<void> {
    const now = context.now ?? this.config.now();
    const goal = await this.store.getCurrentGoal(context.sessionKey);
    this.activeTurns.set(context.sessionKey, {
      sessionKey: context.sessionKey,
      turnId: context.turnId,
      startedAt: now,
      lastTokenTotal: context.tokenUsage?.totalTokens,
      madeMeaningfulProgress: false,
    });
    await this.store.clearReservation(context.sessionKey);
    await this.appendLedger("turn_started", context.sessionKey, goal?.goalId, { turnId: context.turnId }, now);

    if (goal && goal.status === "active") {
      await this.store.saveGoal({
        ...goal,
        goalTurnsSinceAuditReset: goal.goalTurnsSinceAuditReset + 1,
        updatedAt: this.nowIso(now),
      });
    }
  }

  async toolCompleted(context: TurnContext): Promise<void> {
    await this.accountUsage(context.sessionKey, context.tokenUsage);
    const goal = await this.store.getCurrentGoal(context.sessionKey);
    if (!goal) return;

    const meaningfulProgress = context.meaningfulProgress ?? true;
    if (meaningfulProgress && goal.status === "active") {
      this.markMeaningfulProgress(context.sessionKey);
      await this.appendLedger("meaningful_progress", context.sessionKey, goal.goalId, {
        turnId: context.turnId,
        toolName: context.toolName,
        summary: context.progressSummary,
      });
    }

    if (goal.status !== "active" || goal.tokenBudget === undefined) return;
    if (goal.tokensUsed < goal.tokenBudget) return;

    const updated = await this.setGoalStatus(goal, "budgetLimited");
    await this.appendLedger("goal_budget_limited", context.sessionKey, updated.goalId, {
      tokensUsed: updated.tokensUsed,
      tokenBudget: updated.tokenBudget,
    });
    await this.store.clearReservation(context.sessionKey);
    this.markTurnStopped(context.sessionKey, "budgetLimited", updated.goalId, "Goal token budget exhausted.");
    await this.callbacks.injectSteeringContext?.({
      sessionKey: context.sessionKey,
      goalId: updated.goalId,
      kind: "budget_limit",
      renderedPrompt: renderBudgetLimitPrompt(updated),
    });
  }

  async turnFinished(context: TurnContext, completed = true): Promise<void> {
    const tokenDelta = await this.accountUsage(context.sessionKey, context.tokenUsage);
    const turn = this.activeTurns.get(context.sessionKey);
    this.activeTurns.delete(context.sessionKey);
    const goal = await this.store.getCurrentGoal(context.sessionKey);
    await this.appendLedger("turn_finished", context.sessionKey, goal?.goalId, {
      turnId: context.turnId ?? turn?.turnId,
      completed,
      madeMeaningfulProgress: turn?.madeMeaningfulProgress ?? false,
      stopped: turn?.stopped,
      tokensUsedDelta: tokenDelta,
      totalTokensUsed: goal?.tokensUsed,
    });
    if (!completed || turn?.stopped) return;
    if (goal && goal.status === "active") {
      if (turn?.madeMeaningfulProgress) {
        await this.maybeContinueIfIdle(context.sessionKey);
      } else {
        await this.appendLedger("no_progress_continuation_suppressed", context.sessionKey, goal.goalId, {
          turnId: context.turnId ?? turn?.turnId,
        });
      }
    }
  }

  async taskAborted(sessionKey: string): Promise<void> {
    await this.accountUsage(sessionKey);
    this.activeTurns.delete(sessionKey);
    const reservation = await this.store.getReservation(sessionKey);
    if (reservation?.status === "pending") {
      await this.store.clearReservation(sessionKey);
    }
  }

  async usageLimitReached(sessionKey: string): Promise<GoalToolResult> {
    const goal = await this.requireGoal(sessionKey);
    await this.accountUsage(sessionKey);
    const updated = await this.setGoalStatus(goal, "usageLimited");
    await this.appendLedger("goal_usage_limited", sessionKey, updated.goalId);
    await this.store.clearReservation(sessionKey);
    this.activeTurns.delete(sessionKey);
    this.markTurnStopped(sessionKey, "usageLimited", updated.goalId, "Goal stopped because a usage limit was reached.");
    return { goal: updated, message: "Goal stopped because a usage limit was reached." };
  }

  async sessionResumed(sessionKey: string): Promise<void> {
    await this.store.clearExpiredReservations(this.config.now());
    const reservation = await this.store.getReservation(sessionKey);
    if (reservation && new Date(reservation.expiresAt).getTime() <= this.config.now().getTime()) {
      await this.store.clearReservation(sessionKey);
    }
  }

  async maybeContinueIfIdle(sessionKey: string): Promise<HiddenGoalTurnResult | { kind: "notEligible"; reason: string }> {
    if (!this.callbacks.startHiddenGoalTurn) return { kind: "notEligible", reason: "no hidden-turn callback" };

    await this.store.clearExpiredReservations(this.config.now());
    const existingReservation = await this.store.getReservation(sessionKey);
    if (existingReservation) return { kind: "notEligible", reason: "continuation already reserved" };

    const goal = await this.store.getCurrentGoal(sessionKey);
    if (!goal) return { kind: "notEligible", reason: "no current goal" };
    if (!isAutoContinuableStatus(goal.status)) return { kind: "notEligible", reason: `goal is ${goal.status}` };

    const harnessState = await this.readHarnessState(sessionKey);
    const ineligible = explainHarnessIneligible(harnessState);
    if (ineligible) return { kind: "notEligible", reason: ineligible };

    const now = this.config.now();
    const reservation: ContinuationReservation = {
      sessionKey,
      attemptId: this.config.randomId(),
      goalId: goal.goalId,
      goalUpdatedAt: goal.updatedAt,
      attemptCount: 0,
      status: "pending",
      createdAt: this.nowIso(now),
      updatedAt: this.nowIso(now),
      expiresAt: this.nowIso(new Date(now.getTime() + this.config.continuationReservationTtlMs)),
    };
    await this.store.saveReservation(reservation);
    await this.appendLedger("continuation_requested", sessionKey, goal.goalId, {
      attemptId: reservation.attemptId,
      goalUpdatedAt: reservation.goalUpdatedAt,
    }, now);

    let lastResult: HiddenGoalTurnResult = { kind: "fatalFailure", error: "not attempted" };
    for (let attempt = 1; attempt <= this.config.maxContinuationAttempts; attempt += 1) {
      const latestGoal = await this.store.getCurrentGoal(sessionKey);
      if (!latestGoal || latestGoal.goalId !== reservation.goalId || latestGoal.updatedAt !== reservation.goalUpdatedAt || latestGoal.status !== "active") {
        await this.store.clearReservation(sessionKey);
        await this.appendLedger("continuation_skipped", sessionKey, reservation.goalId, {
          attemptId: reservation.attemptId,
          reason: "goal changed before continuation launch",
        });
        return { kind: "skipped", reason: "goal changed before continuation launch" };
      }

      const latestHarnessState = await this.readHarnessState(sessionKey);
      const latestIneligible = explainHarnessIneligible(latestHarnessState);
      if (latestIneligible) {
        await this.store.clearReservation(sessionKey);
        await this.appendLedger("continuation_skipped", sessionKey, reservation.goalId, {
          attemptId: reservation.attemptId,
          reason: latestIneligible,
        });
        return { kind: "skipped", reason: latestIneligible };
      }

      const updatedReservation = { ...reservation, attemptCount: attempt, updatedAt: this.nowIso() };
      await this.store.saveReservation(updatedReservation);

      lastResult = await this.callbacks.startHiddenGoalTurn({
        attemptId: reservation.attemptId,
        sessionKey,
        goalId: reservation.goalId,
        goalUpdatedAt: reservation.goalUpdatedAt,
        attemptCount: attempt,
        hiddenContextKind: "goal_continuation",
        renderedPrompt: renderContinuationPrompt(latestGoal),
      });

      if (lastResult.kind === "started" || lastResult.kind === "alreadyStarted") {
        await this.store.saveReservation({
          ...updatedReservation,
          status: "started",
          hostTurnId: lastResult.hostTurnId,
          updatedAt: this.nowIso(),
        });
        await this.appendLedger(lastResult.kind === "started" ? "continuation_started" : "continuation_already_started", sessionKey, reservation.goalId, {
          attemptId: reservation.attemptId,
          attempt,
          hostTurnId: lastResult.hostTurnId,
        });
        return lastResult;
      }

      if (lastResult.kind === "skipped") {
        await this.store.clearReservation(sessionKey);
        await this.appendLedger("continuation_skipped", sessionKey, reservation.goalId, {
          attemptId: reservation.attemptId,
          attempt,
          reason: lastResult.reason,
        });
        return lastResult;
      }

      if (lastResult.kind === "fatalFailure") {
        await this.store.clearReservation(sessionKey);
        await this.appendLedger("continuation_fatal_failure", sessionKey, reservation.goalId, {
          attemptId: reservation.attemptId,
          attempt,
          error: lastResult.error,
        });
        await this.callbacks.notifyGoalWarning?.(sessionKey, `Goal continuation failed: ${lastResult.error}`);
        return lastResult;
      }

      await this.appendLedger("continuation_retryable_failure", sessionKey, reservation.goalId, {
        attemptId: reservation.attemptId,
        attempt,
        error: lastResult.error,
      });
      if (attempt < this.config.maxContinuationAttempts) {
        await delay(backoffMs(this.config.retryBaseDelayMs, this.config.retryJitterMs, attempt));
      }
    }

    await this.store.clearReservation(sessionKey);
    if (lastResult.kind === "retryableFailure") {
      await this.callbacks.notifyGoalWarning?.(sessionKey, `Goal continuation failed after retries: ${lastResult.error}`);
    }
    return lastResult;
  }

  private async requireGoal(sessionKey: string): Promise<GoalRecord> {
    const goal = await this.store.getCurrentGoal(sessionKey);
    if (!goal) throw new Error("no current goal");
    return goal;
  }

  private async setGoalStatus(goal: GoalRecord, status: GoalRecord["status"]): Promise<GoalRecord> {
    const updated: GoalRecord = { ...goal, status, updatedAt: this.nowIso() };
    await this.store.saveGoal(updated);
    await this.callbacks.notifyGoalUpdated?.(updated);
    return updated;
  }

  private async accountUsage(sessionKey: string, tokenUsage?: TokenUsageSnapshot): Promise<number> {
    const goal = await this.store.getCurrentGoal(sessionKey);
    if (!goal) return 0;
    const turn = this.activeTurns.get(sessionKey);
    const now = this.config.now();
    let tokensUsed = goal.tokensUsed;
    let tokenDelta = 0;
    if (tokenUsage?.totalTokens !== undefined) {
      const previous = turn?.lastTokenTotal ?? 0;
      tokenDelta = Math.max(tokenUsage.totalTokens - previous, 0);
      tokensUsed += tokenDelta;
      if (turn) turn.lastTokenTotal = tokenUsage.totalTokens;
    }

    const elapsedDelta = turn ? Math.max(Math.floor((now.getTime() - turn.startedAt.getTime()) / 1000), 0) : 0;
    await this.store.saveGoal({
      ...goal,
      tokensUsed,
      timeUsedSeconds: Math.max(goal.timeUsedSeconds, goal.timeUsedSeconds + elapsedDelta),
      updatedAt: this.nowIso(now),
    });
    if (turn) turn.startedAt = now;
    return tokenDelta;
  }

  async readHarnessState(sessionKey: string): Promise<HarnessState> {
    if (this.activeTurns.has(sessionKey)) {
      return {
        materialized: true,
        activeTurnId: this.activeTurns.get(sessionKey)?.turnId ?? "active",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      };
    }
    return (
      (await this.callbacks.readHarnessState?.(sessionKey)) ?? {
        materialized: true,
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }
    );
  }

  private async runCompletionAuditIfConfigured(goal: GoalRecord): Promise<CompletionAuditResult | undefined> {
    await this.appendLedger("completion_requested", goal.sessionKey, goal.goalId);
    if (!this.callbacks.auditCompletion) return undefined;

    const completionEvidence = await this.callbacks.collectCompletionEvidence?.(goal);
    const policyContext = await this.callbacks.getCompletionPolicyContext?.(goal);
    const ledgerEvents = await this.store.listLedgerEvents(goal.sessionKey, goal.goalId);
    let result: CompletionAuditResult;
    try {
      result = await this.callbacks.auditCompletion({ goal, ledgerEvents, completionEvidence, policyContext });
    } catch (error) {
      result = {
        approved: false,
        source: "completion-audit-error",
        summary: "Completion audit failed before approval.",
        report: error instanceof Error ? error.message : String(error),
      };
    }
    await this.appendLedger("completion_audit_result", goal.sessionKey, goal.goalId, {
      approved: result.approved,
      summary: result.summary,
      report: result.report,
      source: result.source,
      evidence: result.evidence,
      completionEvidence,
      policyContext,
    });
    return result;
  }

  private markMeaningfulProgress(sessionKey: string): void {
    const turn = this.activeTurns.get(sessionKey);
    if (turn) turn.madeMeaningfulProgress = true;
  }

  private markTurnStopped(sessionKey: string, reason: GoalTurnStopReason, goalId?: string, message?: string): void {
    const turn = this.activeTurns.get(sessionKey);
    if (!turn) return;
    turn.stopped = {
      sessionKey,
      goalId,
      reason,
      at: this.nowIso(),
      message,
    };
  }

  private async appendLedger(
    type: GoalLedgerEventType,
    sessionKey: string,
    goalId?: string,
    details?: Record<string, unknown>,
    date = this.config.now(),
  ): Promise<void> {
    await this.store.appendLedgerEvent({
      eventId: this.config.randomId(),
      sessionKey,
      goalId,
      type,
      at: this.nowIso(date),
      details,
    });
  }

  private nowIso(date = this.config.now()): string {
    return date.toISOString();
  }
}

function selectSubagentForInPlaceContinuation(node: GoalDagNode, subagents: GoalSubagentRecord[], preferredSubagentId?: string): GoalSubagentRecord | undefined {
  if (preferredSubagentId) return subagents.find((subagent) => subagent.subagentId === preferredSubagentId && subagent.status !== "complete");
  const preparedSubagentId = node.preparedResources?.subagentId;
  if (preparedSubagentId) {
    const prepared = subagents.find((subagent) => subagent.subagentId === preparedSubagentId && subagent.status !== "complete");
    if (prepared) return prepared;
  }
  return subagents
    .filter((subagent) => subagent.status !== "complete")
    .sort((left, right) => subagentSortTime(right) - subagentSortTime(left))[0];
}

function subagentSortTime(subagent: GoalSubagentRecord): number {
  return Math.max(
    Date.parse(subagent.updatedAt) || 0,
    Date.parse(subagent.lastActivityAt ?? "") || 0,
    Date.parse(subagent.createdAt) || 0,
  );
}

function resetIntegrationStateForContinuation(subagent: GoalSubagentRecord): GoalSubagentRecord["integrationState"] {
  if (subagent.integrationState === "complete" || subagent.integrationState === "not-required") return subagent.integrationState;
  return subagent.workspacePath || subagent.branch || subagent.ref ? "pending" : undefined;
}

function preparedResourcesForInPlaceContinuation(node: GoalDagNode, subagent: GoalSubagentRecord, now: string): GoalDagNode["preparedResources"] {
  return {
    ...(node.preparedResources ?? {}),
    subagentId: subagent.subagentId,
    adapterId: subagent.harnessAdapterId,
    workspacePath: subagent.workspacePath ?? node.preparedResources?.workspacePath,
    branch: subagent.branch ?? node.preparedResources?.branch,
    ref: subagent.ref ?? node.preparedResources?.ref,
    sessionId: subagent.sessionId ?? node.preparedResources?.sessionId,
    sessionFile: subagent.sessionFile ?? node.preparedResources?.sessionFile,
    updatedAt: now,
  };
}

function retryWorkspaceForNode(node: GoalDagNode, subagents: GoalSubagentRecord[]): GoalDagNode["workspace"] {
  const current = node.workspace;
  const slug = current?.worktreeSlug?.trim();
  if (!slug || current?.branch) return current;
  const baseSlug = slug.replace(/-retry-\d+$/i, "");
  return { ...current, worktreeSlug: safeRetrySlug(`${baseSlug}-retry-${subagents.length + 1}`) };
}

function safeRetrySlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "retry-node";
}

function appendRetryNote(current: string | undefined, note: string): string {
  return current ? `${current}; ${note}` : note;
}

function formatGoalSummary(goal: GoalRecord): string {
  const budget = goal.tokenBudget === undefined ? "none" : `${goal.tokenBudget}`;
  const remaining = goal.tokenBudget === undefined ? "unbounded" : `${Math.max(goal.tokenBudget - goal.tokensUsed, 0)}`;
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens: ${goal.tokensUsed} used / ${budget} budget / ${remaining} remaining`,
    `Elapsed: ${goal.timeUsedSeconds}s`,
  ].join("\n");
}

function normalizeBudgetLimited(goal: GoalRecord): GoalRecord {
  if (goal.status === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return { ...goal, status: "budgetLimited" };
  }
  return goal;
}

function explainHarnessIneligible(state: HarnessState): string | undefined {
  if (!state.materialized) return "session is not materialized";
  if (state.activeTurnId) return "active turn is running";
  if (state.queuedUserInput) return "user input is queued";
  if (state.queuedTriggerTurn) return "trigger turn is queued";
  if (state.continuationSuppressed) return "continuation is suppressed";
  return undefined;
}

function backoffMs(base: number, jitter: number, attempt: number): number {
  const exponential = base * 2 ** Math.max(attempt - 1, 0);
  const randomJitter = jitter > 0 ? Math.floor(Math.random() * jitter) : 0;
  return exponential + randomJitter;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
