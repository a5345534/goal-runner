import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  GoalRuntime,
  SQLiteGoalStore,
  parseGoalCommand,
  renderActiveGoalReminderPrompt,
  type BlockedAuditEvidence,
  type CompletionAuditRequest,
  type CompletionAuditResult,
  type GoalDecisionEvidence,
  type GoalRecord,
  type HiddenGoalTurnRequest,
} from "../../core/index.js";

const EXTENSION_MESSAGE_TYPE = "agent-goal-runtime";
const HIDDEN_CONTEXT_KIND = "goal_continuation";
const POST_STOP_ALLOWED_TOOL_SET = new Set(["get_goal", "read", "grep", "find", "ls"]);
const MEANINGFUL_PROGRESS_TOOL_SET = new Set(["write", "edit", "bash", "read", "grep", "find", "ls"]);

export default function goalPiExtension(pi: ExtensionAPI) {
  const store = new SQLiteGoalStore();
  let lastCtx: ExtensionContext | ExtensionCommandContext | undefined;
  const startedAttempts = new Map<string, string | undefined>();

  const runtime = new GoalRuntime({
    store,
    callbacks: {
      readHarnessState: async (_sessionKey) => {
        const ctx = requireContext(lastCtx);
        return {
          materialized: Boolean(resolveSessionKey(ctx)),
          activeTurnId: ctx.isIdle?.() === false ? "pi-active-turn" : undefined,
          queuedUserInput: Boolean(ctx.hasPendingMessages?.()),
          queuedTriggerTurn: false,
          continuationSuppressed: ctx.hasUI === false,
        };
      },
      startHiddenGoalTurn: async (request) => startHiddenGoalTurn(pi, requireContext(lastCtx), request, startedAttempts),
      injectSteeringContext: async (request) => {
        pi.sendMessage(
          {
            customType: EXTENSION_MESSAGE_TYPE,
            content: request.renderedPrompt,
            display: false,
            details: { kind: request.kind, sessionKey: request.sessionKey, goalId: request.goalId },
          },
          { deliverAs: "steer" },
        );
      },
      notifyGoalUpdated: async (goal) => showGoalStatus(requireContext(lastCtx), goal),
      notifyGoalCleared: async () => {
        const ctx = requireContext(lastCtx);
        ctx.ui?.setStatus?.("goal", undefined);
        ctx.ui?.setWidget?.("goal", undefined);
        ctx.ui?.notify?.("Goal cleared", "info");
      },
      notifyGoalWarning: async (_sessionKey, message) => requireContext(lastCtx).ui?.notify?.(message, "warning"),
      collectCompletionEvidence: async (goal) => buildCompletionEvidence(requireContext(lastCtx), goal),
      getCompletionPolicyContext: async (goal) => buildCompletionPolicyContext(requireContext(lastCtx), goal),
      auditCompletion: completionAuditEnabled() ? heuristicCompletionAudit : undefined,
    },
  });

  pi.registerCommand("goal", {
    description: "Codex-compatible persistent goal: /goal [--tokens 100k] <objective>, /goal edit|pause|resume|clear",
    getArgumentCompletions: (prefix: string) => {
      const commands = ["--tokens", "edit", "pause", "resume", "clear"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      lastCtx = ctx;
      const sessionKey = resolveSessionKey(ctx);
      const trimmed = args.trim();
      try {
        const command = parseGoalCommand(trimmed);

        if (command.kind === "edit" && command.objective === undefined) {
          const current = await runtime.getGoal(sessionKey);
          if (!current.goal) {
            ctx.ui.notify("No current goal to edit", "warning");
            return;
          }
          const nextObjective = await ctx.ui.editor("Edit /goal objective", current.goal.objective);
          if (nextObjective === undefined) return;
          const result = await runtime.executeParsedCommand(sessionKey, command, { editObjective: nextObjective });
          ctx.ui.notify(result.message, "info");
          if (result.goal) showGoalDetails(ctx, result.goal);
          return;
        }

        if (command.kind === "start") {
          const existing = await runtime.getGoal(sessionKey);
          if (existing.goal) {
            const ok = await ctx.ui.confirm(
              "Replace current goal?",
              `${existing.goal.objective}\n\nNew goal:\n${command.objective}${
                command.tokenBudget === undefined ? "" : `\n\nToken budget: ${formatTokenCount(command.tokenBudget)}`
              }`,
            );
            if (!ok) {
              ctx.ui.notify("Goal unchanged", "info");
              return;
            }
          }
        }

        const result = await runtime.executeParsedCommand(sessionKey, command, { confirmReplace: true });
        if (result.goal) showGoalDetails(ctx, result.goal);
        else ctx.ui.notify(result.message, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current goal for this Pi session, including status, budget, usage, and elapsed time.",
    parameters: Type.Object({}),
    promptSnippet: "get_goal returns the current /goal objective and status.",
    promptGuidelines: ["Use get_goal when you need to inspect the active /goal state before deciding whether to continue, complete, or block it."],
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      lastCtx = ctx;
      const result = await runtime.toolGetGoal(resolveSessionKey(ctx));
      return { content: [{ type: "text", text: result.message }], details: result.goal ?? null };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a goal only when explicitly requested by the user/system/developer context and no goal currently exists. Do not infer goals from ordinary tasks.",
    parameters: Type.Object({
      objective: Type.String({ description: "Concrete objective to pursue." }),
      token_budget: Type.Optional(Type.Number({ description: "Optional positive token budget." })),
    }),
    promptSnippet: "create_goal creates a new active /goal only on explicit request and only if none exists.",
    promptGuidelines: ["Use create_goal only when the user/system/developer context explicitly asks to start a /goal; do not infer goals from ordinary tasks."],
    async execute(_toolCallId: string, params: { objective: string; token_budget?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      lastCtx = ctx;
      const result = await runtime.toolCreateGoal(resolveSessionKey(ctx), params.objective, params.token_budget);
      return { content: [{ type: "text", text: result.message }], details: result.goal ?? null };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Update the existing goal. Use complete only when the full objective is achieved and verified. Use blocked only when the same blocking condition has repeated for at least three consecutive goal turns and meaningful progress is impossible without user input or external state change.",
    parameters: Type.Object({
      status: StringEnum(["complete", "blocked"] as const),
    }),
    promptSnippet: "update_goal can mark the active /goal complete or strictly blocked.",
    promptGuidelines: [
      "Use update_goal with status complete only when the full /goal objective is achieved and verified.",
      "Use update_goal with status blocked only after the same blocker recurs for at least three consecutive goal turns; do not use it for ordinary difficulty or a first failure.",
    ],
    async execute(_toolCallId: string, params: { status: "complete" | "blocked" }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      lastCtx = ctx;
      const sessionKey = resolveSessionKey(ctx);
      const current = await runtime.getGoal(sessionKey);
      const blockedAuditEvidence =
        params.status === "blocked" && current.goal ? buildBlockedAuditEvidence(ctx, current.goal, 3) : undefined;
      const result = await runtime.toolUpdateGoal(sessionKey, params.status, { blockedAuditEvidence });
      return { content: [{ type: "text", text: result.message }], details: result.goal ?? null };
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
    const sessionKey = resolveSessionKey(ctx);
    await runtime.sessionResumed(sessionKey);
    const result = await runtime.getGoal(sessionKey);
    if (result.goal) showGoalStatus(ctx, result.goal);
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: ExtensionContext) => {
    lastCtx = ctx;
    const goal = (await runtime.getGoal(resolveSessionKey(ctx))).goal;
    if (!goal || goal.status !== "active") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${renderActiveGoalReminderPrompt(goal)}` };
  });

  pi.on("context", async (event: { messages: Array<Record<string, unknown>> }, ctx: ExtensionContext) => {
    lastCtx = ctx;
    const goal = (await runtime.getGoal(resolveSessionKey(ctx))).goal;
    let filtered = false;
    const messages = event.messages.filter((message) => {
      if (!isStaleGoalContinuationMessage(message, goal)) return true;
      filtered = true;
      return false;
    });
    return filtered ? { messages } : undefined;
  });

  pi.on("turn_start", async (event: { turnIndex?: number; timestamp?: number }, ctx: ExtensionContext) => {
    lastCtx = ctx;
    await runtime.turnStarted({
      sessionKey: resolveSessionKey(ctx),
      turnId: event.turnIndex === undefined ? undefined : `pi-turn-${event.turnIndex}`,
      tokenUsage: readTokenUsage(ctx),
      now: event.timestamp ? new Date(event.timestamp) : undefined,
    });
  });

  pi.on("tool_call", async (event: { toolName?: string }, ctx: ExtensionContext) => {
    lastCtx = ctx;
    const stop = runtime.getCurrentTurnStop(resolveSessionKey(ctx));
    const toolName = event.toolName ?? "unknown";
    if (stop && !POST_STOP_ALLOWED_TOOL_SET.has(toolName)) {
      return {
        block: true,
        reason: `The active goal already stopped in this turn (${stop.reason}). Do not call more write-capable tools; summarize the result and yield to the user.`,
      };
    }
    return;
  });

  pi.on("tool_execution_end", async (event: { toolName?: string }, ctx: ExtensionContext) => {
    lastCtx = ctx;
    const toolName = event.toolName;
    await runtime.toolCompleted({
      sessionKey: resolveSessionKey(ctx),
      tokenUsage: readTokenUsage(ctx),
      toolName,
      meaningfulProgress: toolName === undefined ? false : isMeaningfulProgressTool(toolName),
      progressSummary: toolName,
    });
    if (toolName === "get_goal" || toolName === "create_goal" || toolName === "update_goal") {
      // Goal tool handlers already performed semantic state transitions; this hook keeps accounting fresh.
    }
  });

  pi.on("turn_end", async (event: { message?: Record<string, unknown> }, ctx: ExtensionContext) => {
    lastCtx = ctx;
    const sessionKey = resolveSessionKey(ctx);
    const tokenUsage = readTokenUsage(ctx);

    if (isFailedAssistantTurn(event.message)) {
      const current = await runtime.getGoal(sessionKey);
      if (current.goal?.status === "active") {
        await runtime.pauseGoal(sessionKey);
        ctx.ui?.notify?.(`Goal paused after ${event.message?.stopReason === "aborted" ? "interruption" : "agent error"}. Run /goal resume to continue.`, "warning");
      }
      await runtime.turnFinished({ sessionKey, tokenUsage }, false);
      return;
    }

    await runtime.turnFinished({ sessionKey, tokenUsage }, true);
  });

  pi.on("session_shutdown", async () => {
    await store.close?.();
  });
}

function resolveSessionKey(ctx: ExtensionContext | ExtensionCommandContext): string {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const cwd = ctx.cwd ?? process.cwd();
  return sessionFile ? `pi:${sessionFile}` : `pi:${cwd}:ephemeral`;
}

function requireContext<T extends ExtensionContext | ExtensionCommandContext>(ctx: T | undefined): T {
  if (!ctx) throw new Error("Pi goal adapter has not received a context yet");
  return ctx;
}

function readTokenUsage(ctx: ExtensionContext): { totalTokens?: number } | undefined {
  const entries = (ctx.sessionManager?.getBranch?.() ?? []) as Array<Record<string, unknown>>;
  let totalTokens = 0;

  for (const entry of entries) {
    const message = entry.message as Record<string, unknown> | undefined;
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    if (typeof usage.totalTokens === "number") totalTokens += usage.totalTokens;
    else totalTokens += numberValue(usage.input) + numberValue(usage.output);
  }

  if (totalTokens > 0) return { totalTokens };
  const usage = ctx.getContextUsage?.();
  return typeof usage?.tokens === "number" ? { totalTokens: usage.tokens } : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildBlockedAuditEvidence(
  ctx: ExtensionContext,
  goal: GoalRecord,
  threshold: number,
): BlockedAuditEvidence {
  type TurnEvidence = { signatures: string[]; hasUpdateGoalCall: boolean; timestamp?: string };
  const entries = (ctx.sessionManager?.getBranch?.() ?? []) as Array<Record<string, unknown>>;
  const turns: TurnEvidence[] = [];
  let current: TurnEvidence | undefined;

  for (const entry of entries) {
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (timestamp && timestamp < goal.createdAt) continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;

    if (message.role === "assistant") {
      if (current) turns.push(current);
      current = { signatures: [], hasUpdateGoalCall: false, timestamp };
      const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block.type === "toolCall" && block.name === "update_goal") current.hasUpdateGoalCall = true;
        if (block.type === "text" && typeof block.text === "string") {
          const signature = signatureFromAssistantText(block.text);
          if (signature) current.signatures.push(signature);
        }
      }
      continue;
    }

    if (!current) continue;
    if (message.role === "toolResult" && message.isError === true) {
      const signature = signatureFromToolResult(message);
      if (signature) current.signatures.push(signature);
    }
  }
  if (current) turns.push(current);

  // Exclude the current assistant turn that is performing update_goal; evidence must come from the recent work turns.
  const evidenceTurns = turns.filter((turn) => !turn.hasUpdateGoalCall);
  const recentTurns = evidenceTurns.slice(-threshold);
  const signatures = recentTurns.map((turn) => turn.signatures[0]).filter((signature): signature is string => Boolean(signature));

  if (recentTurns.length < threshold) {
    return {
      inspectedGoalTurns: recentTurns.length,
      consecutiveMatchingTurns: 0,
      reason: `only ${recentTurns.length} recent goal turn(s) available for transcript audit`,
      source: "pi-session-transcript",
    };
  }

  if (signatures.length !== recentTurns.length) {
    return {
      inspectedGoalTurns: recentTurns.length,
      consecutiveMatchingTurns: 0,
      reason: "not every recent goal turn contains a recognizable blocker signature",
      source: "pi-session-transcript",
    };
  }

  const [latestSignature] = signatures.slice(-1);
  let consecutive = 0;
  for (let index = signatures.length - 1; index >= 0; index -= 1) {
    if (signatures[index] !== latestSignature) break;
    consecutive += 1;
  }

  return {
    inspectedGoalTurns: recentTurns.length,
    consecutiveMatchingTurns: consecutive,
    blockerSignature: latestSignature,
    reason: consecutive >= threshold ? undefined : "recent blocker signatures are not the same",
    source: "pi-session-transcript",
  };
}

function signatureFromToolResult(message: Record<string, unknown>): string | undefined {
  const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
  const text = textFromContent(message.content);
  const line = firstDiagnosticLine(text);
  return line ? `${toolName}:${normalizeSignature(line)}` : undefined;
}

function signatureFromAssistantText(text: string): string | undefined {
  if (!/(blocked|cannot proceed|can't proceed|need user|external state|無法|不能|需要使用者|阻塞|卡住)/i.test(text)) {
    return undefined;
  }
  return `assistant:${normalizeSignature(firstDiagnosticLine(text) ?? text)}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function firstDiagnosticLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /(error|fail|failed|panic|blocked|cannot|can't|couldn't|not found|missing|denied|無法|錯誤|失敗|缺少)/i.test(line)) ??
    lines[0]
  );
}

function normalizeSignature(line: string): string {
  return line
    .toLowerCase()
    .replace(/\/[\w./:@-]+/g, "<path>")
    .replace(/[a-f0-9]{8,}/g, "<hex>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function completionAuditEnabled(): boolean {
  const value = String(process.env.AGENT_GOAL_COMPLETION_AUDIT ?? process.env.PI_GOAL_COMPLETION_AUDIT ?? "heuristic").toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "disabled";
}

function isMeaningfulProgressTool(toolName: string): boolean {
  return MEANINGFUL_PROGRESS_TOOL_SET.has(toolName);
}

function buildCompletionEvidence(ctx: ExtensionContext | ExtensionCommandContext, goal: GoalRecord): GoalDecisionEvidence {
  const entries = (ctx.sessionManager?.getBranch?.() ?? []) as Array<Record<string, unknown>>;
  const toolNames = new Set<string>();
  const commands: string[] = [];
  const verificationSignals: string[] = [];

  for (const entry of entries) {
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (timestamp && timestamp < goal.createdAt) continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;

    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block.type === "toolCall" && typeof block.name === "string") {
          toolNames.add(block.name);
          const args = block.args as Record<string, unknown> | undefined;
          const command = typeof args?.command === "string" ? args.command : undefined;
          if (command) {
            commands.push(command);
            if (isVerificationCommand(command)) verificationSignals.push(`command:${command}`);
          }
        }
        if (block.type === "text" && typeof block.text === "string") {
          const signal = verificationSignalFromText(block.text);
          if (signal) verificationSignals.push(signal);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      if (toolName) toolNames.add(toolName);
      const text = textFromContent(message.content);
      const signal = verificationSignalFromText(text);
      if (signal) verificationSignals.push(signal);
    }
  }

  const uniqueCommands = unique(commands).slice(-10);
  const uniqueSignals = unique(verificationSignals).slice(-20);
  const uniqueTools = [...toolNames].sort();
  return {
    source: "pi-session-transcript",
    summary: uniqueSignals.length > 0
      ? `Found ${uniqueSignals.length} verification signal(s) in the Pi transcript.`
      : `Found ${uniqueTools.length} task tool(s) in the Pi transcript.`,
    verificationSignals: uniqueSignals,
    commands: uniqueCommands,
    toolNames: uniqueTools,
  };
}

function buildCompletionPolicyContext(ctx: ExtensionContext | ExtensionCommandContext, goal: GoalRecord): Record<string, unknown> | undefined {
  const cwd = ctx.cwd ?? process.cwd();
  const hasOpenSpec = fs.existsSync(`${cwd}/openspec/project.md`) || fs.existsSync(`${cwd}/openspec/specs`);
  if (!hasOpenSpec && !/openspec/i.test(goal.objective)) return undefined;
  return {
    source: "pi-adapter-openspec-policy-context",
    openspecWorkspaceDetected: hasOpenSpec,
    guidance: [
      "If this goal executes an OpenSpec change, completion evidence should include finished tasks and relevant openspec validation.",
      "If this goal closes or archives a change, completion evidence should include archive-preflight/readiness results.",
      "OpenSpec remains the planning/specification source of truth; /goal is only the execution persistence layer.",
    ],
  };
}

function heuristicCompletionAudit(request: CompletionAuditRequest): CompletionAuditResult {
  const evidence = request.completionEvidence;
  const signals = Array.isArray(evidence?.verificationSignals) ? evidence.verificationSignals : [];
  const toolNames = Array.isArray(evidence?.toolNames) ? evidence.toolNames.filter((value): value is string => typeof value === "string") : [];
  const commands = Array.isArray(evidence?.commands) ? evidence.commands.filter((value): value is string => typeof value === "string") : [];
  const hasTaskTool = toolNames.some((toolName) => MEANINGFUL_PROGRESS_TOOL_SET.has(toolName));
  const hasVerification = signals.length > 0 || commands.some(isVerificationCommand);

  if (hasVerification || hasTaskTool) {
    return {
      approved: true,
      source: "pi-transcript-heuristic-auditor",
      summary: hasVerification
        ? "Completion approved: transcript contains verification evidence."
        : "Completion approved: transcript contains task-relevant tool evidence.",
      evidence,
    };
  }

  return {
    approved: false,
    source: "pi-transcript-heuristic-auditor",
    summary: "No task-relevant tool use or verification evidence was found in the Pi transcript for this goal.",
    report: "Inspect current artifacts, run or cite verification, then request completion again.",
    evidence,
  };
}

function isVerificationCommand(command: string): boolean {
  return /(^|\s)(npm\s+run\s+(check|test|build)|npm\s+test|pnpm\s+(test|build|check)|yarn\s+(test|build|check)|mvn\s+test|gradle\s+test|pytest|go\s+test|cargo\s+test|openspec\s+validate|archive-preflight|tsc|eslint)\b/i.test(command);
}

function verificationSignalFromText(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /(pass(ed)?|valid|success|succeeded|ok|no errors|0 failing|build success|change .* is valid|通過|成功)/i.test(value));
  return line ? `text:${line.slice(0, 240)}` : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function startHiddenGoalTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  request: HiddenGoalTurnRequest,
  startedAttempts: Map<string, string | undefined>,
) {
  if (startedAttempts.has(request.attemptId)) {
    return { kind: "alreadyStarted" as const, hostTurnId: startedAttempts.get(request.attemptId) };
  }
  if (ctx.isIdle?.() === false) return { kind: "skipped" as const, reason: "active turn is running" };
  if (ctx.hasPendingMessages?.()) return { kind: "skipped" as const, reason: "user input is queued" };

  try {
    const hostTurnId = `pi-hidden-${request.attemptId}`;
    pi.sendMessage(
      {
        customType: EXTENSION_MESSAGE_TYPE,
        content: request.renderedPrompt,
        display: false,
        details: {
          kind: HIDDEN_CONTEXT_KIND,
          attemptId: request.attemptId,
          sessionKey: request.sessionKey,
          goalId: request.goalId,
          goalUpdatedAt: request.goalUpdatedAt,
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    startedAttempts.set(request.attemptId, hostTurnId);
    ctx.ui?.setStatus?.("goal", "🎯 continuing");
    return { kind: "started" as const, hostTurnId };
  } catch (error) {
    return { kind: "retryableFailure" as const, error: error instanceof Error ? error.message : String(error) };
  }
}

function isFailedAssistantTurn(message: Record<string, unknown> | undefined): boolean {
  return message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
}

function isStaleGoalContinuationMessage(message: Record<string, unknown>, goal: GoalRecord | undefined): boolean {
  if (message.role !== "custom" || message.customType !== EXTENSION_MESSAGE_TYPE) return false;
  const details = message.details as Record<string, unknown> | undefined;
  if (details?.kind !== HIDDEN_CONTEXT_KIND) return false;
  return !goal || goal.status !== "active" || details.goalId !== goal.goalId || details.goalUpdatedAt !== goal.updatedAt;
}

function showGoalStatus(ctx: ExtensionContext | ExtensionCommandContext, goal: GoalRecord): void {
  ctx.ui?.setStatus?.("goal", compactGoalStatus(goal));
  ctx.ui?.setWidget?.("goal", [`/goal ${goal.status}: ${goal.objective}`], { placement: "belowEditor" });
}

function showGoalDetails(ctx: ExtensionContext | ExtensionCommandContext, goal: GoalRecord): void {
  showGoalStatus(ctx, goal);
  ctx.ui?.notify?.(goalSummary(goal), "info");
}

function goalSummary(goal: GoalRecord): string {
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Goal turns since audit reset: ${goal.goalTurnsSinceAuditReset}`,
    `Elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
    `Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`}`,
    `Commands: ${goalCommandHint(goal.status)}`,
  ].join("\n");
}

function compactGoalStatus(goal: GoalRecord): string {
  switch (goal.status) {
    case "active":
      return goal.tokenBudget === undefined
        ? `🎯 active ${formatDuration(goal.timeUsedSeconds)}`
        : `🎯 active ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
    case "paused":
      return "🎯 paused";
    case "blocked":
      return "🎯 blocked";
    case "budgetLimited":
      return `🎯 budget ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
    case "usageLimited":
      return "🎯 usage limited";
    case "complete":
      return "🎯 complete";
  }
}

function goalCommandHint(status: GoalRecord["status"]): string {
  if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
  if (status === "paused" || status === "budgetLimited") return "/goal edit <objective>, /goal resume, /goal clear";
  return "/goal edit <objective>, /goal clear";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
  return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}
