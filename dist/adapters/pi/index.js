import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GoalRuntime, SQLiteGoalStore, } from "../../core/index.js";
const EXTENSION_MESSAGE_TYPE = "agent-goal-runtime";
const HIDDEN_CONTEXT_KIND = "goal_continuation";
export default function goalPiExtension(pi) {
    const store = new SQLiteGoalStore();
    let lastCtx;
    const startedAttempts = new Map();
    const runtime = new GoalRuntime({
        store,
        callbacks: {
            readHarnessState: async (sessionKey) => {
                const ctx = requireContext(lastCtx);
                return {
                    materialized: Boolean(resolveSessionKey(ctx)),
                    activeTurnId: ctx.isIdle?.() === false ? "pi-active-turn" : undefined,
                    queuedUserInput: Boolean(ctx.hasPendingMessages?.()),
                    queuedTriggerTurn: false,
                    continuationSuppressed: false,
                };
            },
            startHiddenGoalTurn: async (request) => startHiddenGoalTurn(pi, requireContext(lastCtx), request, startedAttempts),
            injectSteeringContext: async (request) => {
                pi.sendMessage({
                    customType: EXTENSION_MESSAGE_TYPE,
                    content: request.renderedPrompt,
                    display: false,
                    details: { kind: request.kind, sessionKey: request.sessionKey, goalId: request.goalId },
                }, { deliverAs: "steer" });
            },
            notifyGoalUpdated: async (goal) => showGoalStatus(requireContext(lastCtx), goal),
            notifyGoalCleared: async () => {
                const ctx = requireContext(lastCtx);
                ctx.ui?.setStatus?.("goal", undefined);
                ctx.ui?.setWidget?.("goal", undefined);
                ctx.ui?.notify?.("Goal cleared", "info");
            },
            notifyGoalWarning: async (_sessionKey, message) => requireContext(lastCtx).ui?.notify?.(message, "warning"),
        },
    });
    pi.registerCommand("goal", {
        description: "Codex-compatible persistent goal: /goal, /goal <objective>, /goal edit|pause|resume|clear",
        getArgumentCompletions: (prefix) => {
            const commands = ["edit", "pause", "resume", "clear"];
            const matches = commands.filter((command) => command.startsWith(prefix));
            return matches.length ? matches.map((value) => ({ value, label: value })) : null;
        },
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const sessionKey = resolveSessionKey(ctx);
            const trimmed = args.trim();
            try {
                if (trimmed === "edit") {
                    const current = await runtime.getGoal(sessionKey);
                    if (!current.goal) {
                        ctx.ui.notify("No current goal to edit", "warning");
                        return;
                    }
                    const nextObjective = await ctx.ui.editor("Edit /goal objective", current.goal.objective);
                    if (nextObjective === undefined)
                        return;
                    const result = await runtime.executeCommand(sessionKey, "edit", { editObjective: nextObjective });
                    ctx.ui.notify(result.message, "info");
                    return;
                }
                if (trimmed && !["pause", "resume", "clear"].includes(trimmed)) {
                    const existing = await runtime.getGoal(sessionKey);
                    if (existing.goal) {
                        const ok = await ctx.ui.confirm("Replace current goal?", `${existing.goal.objective}\n\nNew goal:\n${trimmed}`);
                        if (!ok) {
                            ctx.ui.notify("Goal unchanged", "info");
                            return;
                        }
                    }
                }
                const result = await runtime.executeCommand(sessionKey, trimmed, { confirmReplace: true });
                if (result.goal)
                    showGoalDetails(ctx, result.goal);
                else
                    ctx.ui.notify(result.message, "info");
            }
            catch (error) {
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
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            lastCtx = ctx;
            const result = await runtime.toolGetGoal(resolveSessionKey(ctx));
            return { content: [{ type: "text", text: result.message }], details: result.goal ?? null };
        },
    });
    pi.registerTool({
        name: "create_goal",
        label: "Create Goal",
        description: "Create a goal only when explicitly requested by the user/system/developer context and no goal currently exists. Do not infer goals from ordinary tasks.",
        parameters: Type.Object({
            objective: Type.String({ description: "Concrete objective to pursue." }),
            token_budget: Type.Optional(Type.Number({ description: "Optional positive token budget." })),
        }),
        promptSnippet: "create_goal creates a new active /goal only on explicit request and only if none exists.",
        promptGuidelines: ["Use create_goal only when the user/system/developer context explicitly asks to start a /goal; do not infer goals from ordinary tasks."],
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            lastCtx = ctx;
            const result = await runtime.toolCreateGoal(resolveSessionKey(ctx), params.objective, params.token_budget);
            return { content: [{ type: "text", text: result.message }], details: result.goal ?? null };
        },
    });
    pi.registerTool({
        name: "update_goal",
        label: "Update Goal",
        description: "Update the existing goal. Use complete only when the full objective is achieved and verified. Use blocked only when the same blocking condition has repeated for at least three consecutive goal turns and meaningful progress is impossible without user input or external state change.",
        parameters: Type.Object({
            status: StringEnum(["complete", "blocked"]),
        }),
        promptSnippet: "update_goal can mark the active /goal complete or strictly blocked.",
        promptGuidelines: [
            "Use update_goal with status complete only when the full /goal objective is achieved and verified.",
            "Use update_goal with status blocked only after the same blocker recurs for at least three consecutive goal turns; do not use it for ordinary difficulty or a first failure.",
        ],
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            lastCtx = ctx;
            const sessionKey = resolveSessionKey(ctx);
            const current = await runtime.getGoal(sessionKey);
            const blockedAuditEvidence = params.status === "blocked" && current.goal ? buildBlockedAuditEvidence(ctx, current.goal, 3) : undefined;
            const result = await runtime.toolUpdateGoal(sessionKey, params.status, { blockedAuditEvidence });
            return { content: [{ type: "text", text: result.message }], details: result.goal ?? null };
        },
    });
    pi.on("session_start", async (_event, ctx) => {
        lastCtx = ctx;
        const sessionKey = resolveSessionKey(ctx);
        await runtime.sessionResumed(sessionKey);
        const result = await runtime.getGoal(sessionKey);
        if (result.goal)
            showGoalStatus(ctx, result.goal);
    });
    pi.on("turn_start", async (event, ctx) => {
        lastCtx = ctx;
        await runtime.turnStarted({
            sessionKey: resolveSessionKey(ctx),
            turnId: event.turnIndex === undefined ? undefined : `pi-turn-${event.turnIndex}`,
            tokenUsage: readTokenUsage(ctx),
            now: event.timestamp ? new Date(event.timestamp) : undefined,
        });
    });
    pi.on("tool_execution_end", async (event, ctx) => {
        lastCtx = ctx;
        await runtime.toolCompleted({ sessionKey: resolveSessionKey(ctx), tokenUsage: readTokenUsage(ctx) });
        if (event.toolName === "get_goal" || event.toolName === "create_goal" || event.toolName === "update_goal") {
            // Goal tool handlers already performed semantic state transitions; this hook keeps accounting fresh.
        }
    });
    pi.on("turn_end", async (_event, ctx) => {
        lastCtx = ctx;
        await runtime.turnFinished({ sessionKey: resolveSessionKey(ctx), tokenUsage: readTokenUsage(ctx) }, true);
    });
    pi.on("session_shutdown", async () => {
        await store.close?.();
    });
}
function resolveSessionKey(ctx) {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const cwd = ctx.cwd ?? process.cwd();
    return sessionFile ? `pi:${sessionFile}` : `pi:${cwd}:ephemeral`;
}
function requireContext(ctx) {
    if (!ctx)
        throw new Error("Pi goal adapter has not received a context yet");
    return ctx;
}
function readTokenUsage(ctx) {
    const usage = ctx.getContextUsage?.();
    return usage?.tokens === undefined ? undefined : { totalTokens: usage.tokens };
}
function buildBlockedAuditEvidence(ctx, goal, threshold) {
    const entries = (ctx.sessionManager?.getBranch?.() ?? []);
    const turns = [];
    let current;
    for (const entry of entries) {
        const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
        if (timestamp && timestamp < goal.createdAt)
            continue;
        const message = entry.message;
        if (!message)
            continue;
        if (message.role === "assistant") {
            if (current)
                turns.push(current);
            current = { signatures: [], hasUpdateGoalCall: false, timestamp };
            const content = Array.isArray(message.content) ? message.content : [];
            for (const block of content) {
                if (block.type === "toolCall" && block.name === "update_goal")
                    current.hasUpdateGoalCall = true;
                if (block.type === "text" && typeof block.text === "string") {
                    const signature = signatureFromAssistantText(block.text);
                    if (signature)
                        current.signatures.push(signature);
                }
            }
            continue;
        }
        if (!current)
            continue;
        if (message.role === "toolResult" && message.isError === true) {
            const signature = signatureFromToolResult(message);
            if (signature)
                current.signatures.push(signature);
        }
    }
    if (current)
        turns.push(current);
    // Exclude the current assistant turn that is performing update_goal; evidence must come from the recent work turns.
    const evidenceTurns = turns.filter((turn) => !turn.hasUpdateGoalCall);
    const recentTurns = evidenceTurns.slice(-threshold);
    const signatures = recentTurns.map((turn) => turn.signatures[0]).filter((signature) => Boolean(signature));
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
        if (signatures[index] !== latestSignature)
            break;
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
function signatureFromToolResult(message) {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const text = textFromContent(message.content);
    const line = firstDiagnosticLine(text);
    return line ? `${toolName}:${normalizeSignature(line)}` : undefined;
}
function signatureFromAssistantText(text) {
    if (!/(blocked|cannot proceed|can't proceed|need user|external state|無法|不能|需要使用者|阻塞|卡住)/i.test(text)) {
        return undefined;
    }
    return `assistant:${normalizeSignature(firstDiagnosticLine(text) ?? text)}`;
}
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((block) => {
        if (!block || typeof block !== "object")
            return "";
        const value = block;
        return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
        .filter(Boolean)
        .join("\n");
}
function firstDiagnosticLine(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return (lines.find((line) => /(error|fail|failed|panic|blocked|cannot|can't|couldn't|not found|missing|denied|無法|錯誤|失敗|缺少)/i.test(line)) ??
        lines[0]);
}
function normalizeSignature(line) {
    return line
        .toLowerCase()
        .replace(/\/[\w./:@-]+/g, "<path>")
        .replace(/[a-f0-9]{8,}/g, "<hex>")
        .replace(/\b\d+\b/g, "<num>")
        .replace(/\s+/g, " ")
        .slice(0, 240);
}
async function startHiddenGoalTurn(pi, ctx, request, startedAttempts) {
    if (startedAttempts.has(request.attemptId)) {
        return { kind: "alreadyStarted", hostTurnId: startedAttempts.get(request.attemptId) };
    }
    if (ctx.isIdle?.() === false)
        return { kind: "skipped", reason: "active turn is running" };
    if (ctx.hasPendingMessages?.())
        return { kind: "skipped", reason: "user input is queued" };
    try {
        const hostTurnId = `pi-hidden-${request.attemptId}`;
        pi.sendMessage({
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
        }, { triggerTurn: true, deliverAs: "followUp" });
        startedAttempts.set(request.attemptId, hostTurnId);
        ctx.ui?.setStatus?.("goal", "goal: continuing");
        return { kind: "started", hostTurnId };
    }
    catch (error) {
        return { kind: "retryableFailure", error: error instanceof Error ? error.message : String(error) };
    }
}
function showGoalStatus(ctx, goal) {
    ctx.ui?.setStatus?.("goal", `goal: ${goal.status}`);
    ctx.ui?.setWidget?.("goal", [`/goal ${goal.status}: ${goal.objective}`], { placement: "belowEditor" });
}
function showGoalDetails(ctx, goal) {
    showGoalStatus(ctx, goal);
    const budget = goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
    ctx.ui?.notify?.(`Goal ${goal.status}\n${goal.objective}\nTokens: ${goal.tokensUsed}/${budget}`, "info");
}
//# sourceMappingURL=index.js.map