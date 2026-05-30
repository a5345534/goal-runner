import { randomUUID } from "node:crypto";
import { parseGoalCommand, validateGoalObjective, type GoalCommand } from "./parser.js";
import { renderBudgetLimitPrompt, renderContinuationPrompt, renderObjectiveUpdatedPrompt } from "./prompts.js";
import { isAutoContinuableStatus, normalizeGoalStatus } from "./status.js";
import type {
  ContinuationReservation,
  GoalAdapterCallbacks,
  GoalRecord,
  GoalRuntimeConfig,
  GoalStatusInput,
  GoalStore,
  GoalToolResult,
  HarnessState,
  BlockedAuditEvidence,
  HiddenGoalTurnResult,
  TokenUsageSnapshot,
  TurnContext,
} from "./types.js";

interface ActiveTurnState {
  turnId?: string;
  sessionKey: string;
  startedAt: Date;
  lastTokenTotal?: number;
}

export class GoalRuntime {
  private readonly store: GoalStore;
  private readonly callbacks: GoalAdapterCallbacks;
  private readonly config: Required<GoalRuntimeConfig>;
  private readonly activeTurns = new Map<string, ActiveTurnState>();

  constructor(options: { store: GoalStore; callbacks?: GoalAdapterCallbacks; config?: GoalRuntimeConfig }) {
    this.store = options.store;
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

  async createOrReplaceGoal(
    sessionKey: string,
    objectiveInput: string,
    options: { tokenBudget?: number; confirmReplace?: boolean } = {},
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
    await this.store.clearReservation(sessionKey);
    await this.callbacks.notifyGoalUpdated?.(goal);
    await this.maybeContinueIfIdle(sessionKey);
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
    await this.store.clearReservation(sessionKey);
    return { goal: updated, message: "Goal paused." };
  }

  async resumeGoal(sessionKey: string): Promise<GoalToolResult> {
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
    await this.store.clearReservation(sessionKey);
    await this.callbacks.notifyGoalUpdated?.(updated);
    await this.maybeContinueIfIdle(sessionKey);
    return {
      goal: updated,
      message: updated.status === "budgetLimited" ? "Goal token budget is still exhausted." : "Goal resumed.",
    };
  }

  async clearGoal(sessionKey: string): Promise<GoalToolResult> {
    await this.store.clearGoal(sessionKey);
    this.activeTurns.delete(sessionKey);
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
    const goal = await this.requireGoal(sessionKey);
    await this.accountUsage(sessionKey);

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
    }

    const updated = await this.setGoalStatus(goal, status);
    await this.store.clearReservation(sessionKey);
    return { goal: updated, message: status === "complete" ? "Goal marked complete." : "Goal marked blocked." };
  }

  async turnStarted(context: TurnContext): Promise<void> {
    const now = context.now ?? this.config.now();
    const goal = await this.store.getCurrentGoal(context.sessionKey);
    this.activeTurns.set(context.sessionKey, {
      sessionKey: context.sessionKey,
      turnId: context.turnId,
      startedAt: now,
      lastTokenTotal: context.tokenUsage?.totalTokens,
    });
    await this.store.clearReservation(context.sessionKey);

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
    if (!goal || goal.status !== "active" || goal.tokenBudget === undefined) return;
    if (goal.tokensUsed < goal.tokenBudget) return;

    const updated = await this.setGoalStatus(goal, "budgetLimited");
    await this.store.clearReservation(context.sessionKey);
    await this.callbacks.injectSteeringContext?.({
      sessionKey: context.sessionKey,
      goalId: updated.goalId,
      kind: "budget_limit",
      renderedPrompt: renderBudgetLimitPrompt(updated),
    });
  }

  async turnFinished(context: TurnContext, completed = true): Promise<void> {
    await this.accountUsage(context.sessionKey, context.tokenUsage);
    this.activeTurns.delete(context.sessionKey);
    if (!completed) return;
    const goal = await this.store.getCurrentGoal(context.sessionKey);
    if (goal && goal.status === "active") {
      await this.maybeContinueIfIdle(context.sessionKey);
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
    await this.store.clearReservation(sessionKey);
    this.activeTurns.delete(sessionKey);
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

    let lastResult: HiddenGoalTurnResult = { kind: "fatalFailure", error: "not attempted" };
    for (let attempt = 1; attempt <= this.config.maxContinuationAttempts; attempt += 1) {
      const latestGoal = await this.store.getCurrentGoal(sessionKey);
      if (!latestGoal || latestGoal.goalId !== reservation.goalId || latestGoal.updatedAt !== reservation.goalUpdatedAt || latestGoal.status !== "active") {
        await this.store.clearReservation(sessionKey);
        return { kind: "skipped", reason: "goal changed before continuation launch" };
      }

      const latestHarnessState = await this.readHarnessState(sessionKey);
      const latestIneligible = explainHarnessIneligible(latestHarnessState);
      if (latestIneligible) {
        await this.store.clearReservation(sessionKey);
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
        return lastResult;
      }

      if (lastResult.kind === "skipped") {
        await this.store.clearReservation(sessionKey);
        return lastResult;
      }

      if (lastResult.kind === "fatalFailure") {
        await this.store.clearReservation(sessionKey);
        await this.callbacks.notifyGoalWarning?.(sessionKey, `Goal continuation failed: ${lastResult.error}`);
        return lastResult;
      }

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

  private async accountUsage(sessionKey: string, tokenUsage?: TokenUsageSnapshot): Promise<void> {
    const goal = await this.store.getCurrentGoal(sessionKey);
    if (!goal) return;
    const turn = this.activeTurns.get(sessionKey);
    const now = this.config.now();
    let tokensUsed = goal.tokensUsed;
    if (tokenUsage?.totalTokens !== undefined) {
      const previous = turn?.lastTokenTotal ?? 0;
      const delta = Math.max(tokenUsage.totalTokens - previous, 0);
      tokensUsed += delta;
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
  }

  private async readHarnessState(sessionKey: string): Promise<HarnessState> {
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

  private nowIso(date = this.config.now()): string {
    return date.toISOString();
  }
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
