// OpenCode `/goal` plugin entry point.
//
// This file is the bridge between the opencode plugin hook surface and
// the portable `GoalRuntime`. It does not register any UI; instead it
// exposes:
//
//   - Codex-compatible `get_goal`, `create_goal`, `update_goal` tools
//   - A `goal_command` tool that accepts the full `/goal` argument
//     string (so the model can run `/goal` from `opencode run` /
//     `opencode serve` modes where there is no TUI slash command).
//   - An `event` hook that maps opencode session lifecycle events into
//     the portable runtime hooks.
//   - A `command.execute.before` hook that intercepts the user's
//     `/goal <args>` input in the TUI.
//   - A `tool.execute.before` / `tool.execute.after` pair that
//     implements the same-turn post-stop guard and progress-gated
//     continuation the Pi adapter uses.
//   - An `experimental.chat.messages.transform` hook that rewrites
//     stale hidden continuation bookkeeping the same way the Pi
//     adapter does.
//   - A `tui.command.register` registration that adds a `/goal` slash
//     command in TUI mode (best-effort, skipped when `ctx.tui` is
//     missing).
//
// Like the Pi adapter, this file is the only place in the opencode
// adapter that knows about the opencode hook surface. Everything else
// (DAG planner, controller loop, store, native git workspace manager,
// parser) is reused from the portable core.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { GoalRuntime, NativeGitWorkspaceManager, SQLiteGoalStore, cleanupTerminalSubagentWorkspaces, createControllerValidationRunner, createNativeGitSubagentBranchIntegrator, createNativeGitSubagentWorkspaceAllocator, parseGoalCommand, parseGoalDagFileContent, parseTokenBudget, renderActiveGoalReminderPrompt, } from "../../core/index.js";
import { buildOpencodeCompletionEvidence, readOpencodeSessionMessages, readOpencodeTokenUsage, summariseOpencodeSession } from "./session-transcript.js";
import { isOpencodeSessionCompactedEvent, isOpencodeSessionErrorEvent, isOpencodeSessionIdleEvent, extractOpencodeEventSessionID, OpencodeHiddenContinuationRegistry, rewriteOpencodeQueuedContinuations, startOpencodeHiddenGoalTurn, } from "./hidden-continuation.js";
import { OpencodeHarnessSubagentAdapter, createOpencodeHarnessSubagentAdapter } from "./subagent-adapter.js";
import { resolveWorkspaceBinding, tokenize, validateExecutionWorkspace } from "./workspace.js";
import { isOpencodeCompletionAuditEnabled, opencodeHeuristicCompletionAudit } from "./completion-audit.js";
import { buildOpencodeBlockedAuditEvidence } from "./blocked-audit.js";
import { parseOpencodeGoalCommand, formatOpencodeGoalToolDescription, stripSlashPrefix, OPENCODE_GOAL_TOOL, OPENCODE_GOAL_SLASH } from "./slash-command.js";
import { readOpencodeModelRoutingConfig, resolveOpencodeControllerModel, selectOpencodeSubagentModel } from "./model-routing.js";
import { createAuditModel, controllerAuditOptions } from "../pi/controller-audit-model.js";
import { readOpencodeGoalMonitorSnapshot } from "./monitor-ui.js";
import { finalizeOpencodeGoalFromDagTerminalState, formatOpencodeCloseoutDiagnostics } from "./closeout.js";
const MEANINGFUL_PROGRESS_TOOL_SET = new Set(["write", "edit", "bash", "read", "grep", "find", "ls"]);
const POST_STOP_ALLOWED_TOOL_SET = new Set(["get_goal", "read", "grep", "find", "ls"]);
const OPENCODE_STATE_DIR_NAME = ".goal-runner";
const LEGACY_OPENCODE_STATE_DIR_NAME = ".agent-goal-runtime";
function resolveDefaultOpencodeStateRoot() {
    if (process.env.AGENT_GOAL_STATE_HOME)
        return process.env.AGENT_GOAL_STATE_HOME;
    const nextRoot = join(process.cwd(), OPENCODE_STATE_DIR_NAME);
    const legacyRoot = join(process.cwd(), LEGACY_OPENCODE_STATE_DIR_NAME);
    if (!fs.existsSync(nextRoot) && fs.existsSync(legacyRoot))
        return legacyRoot;
    return nextRoot;
}
export function createOpencodeGoalPluginContext(options = {}) {
    const stateRoot = options.stateRoot ?? resolveDefaultOpencodeStateRoot();
    const store = new SQLiteGoalStore({ stateRoot });
    const registry = new OpencodeHiddenContinuationRegistry();
    const subagentAdapter = options.subagentAdapter ?? createOpencodeHarnessSubagentAdapter();
    const now = options.now ?? (() => new Date());
    const runtime = options.runtime ?? new GoalRuntime({
        store,
        callbacks: {
            readHarnessState: async (sessionKey) => {
                const sessionID = sessionIDForKey(sessionKey);
                return {
                    materialized: Boolean(sessionID),
                    activeTurnId: undefined,
                    queuedUserInput: false,
                    queuedTriggerTurn: false,
                    continuationSuppressed: false,
                    ...(sessionID ? { sessionBusy: contextState()?.busySessions.has(sessionID) ?? false } : {}),
                };
            },
            startHiddenGoalTurn: async (request) => startOpencodeHiddenGoalTurnWithContext(request),
            injectSteeringContext: async (request) => injectSteeringContext(request),
            notifyGoalUpdated: async (goal) => pushNotification(goal.sessionKey, "info", compactGoalStatus(goal)),
            notifyGoalCleared: async (sessionKey) => pushNotification(sessionKey, "info", "Goal cleared"),
            notifyGoalWarning: async (sessionKey, message) => pushNotification(sessionKey, "warning", message),
            collectCompletionEvidence: async (goal) => collectCompletionEvidence(goal),
            getCompletionPolicyContext: async (goal) => buildCompletionPolicyContext(goal),
            auditCompletion: isOpencodeCompletionAuditEnabled() ? opencodeHeuristicCompletionAudit : undefined,
        },
    });
    const context = {
        store,
        runtime,
        subagentAdapter,
        registry,
        goalBySessionKey: new Map(),
        activeSessionID: "",
        activeCwd: process.cwd(),
        now,
        notifications: [],
        lastGoalSummary: new Map(),
        busySessions: new Set(),
        backgroundPollers: new Map(),
        backgroundSessions: new Map(),
    };
    return context;
    function contextState() {
        return context;
    }
    async function startOpencodeHiddenGoalTurnWithContext(request) {
        const ctxState = contextState();
        if (!ctxState.activeSessionID)
            return { kind: "fatalFailure", error: "no active opencode session" };
        return startOpencodeHiddenGoalTurn({
            client: currentClient(),
            sessionID: ctxState.activeSessionID,
            busy: () => ctxState.busySessions.has(ctxState.activeSessionID),
            hasQueuedUserInput: () => false,
        }, request, ctxState.registry);
    }
    async function injectSteeringContext(request) {
        const ctxState = contextState();
        const sessionID = sessionIDForKey(request.sessionKey) ?? ctxState.activeSessionID;
        if (!sessionID)
            return;
        try {
            await currentClient().session.prompt?.({
                sessionID,
                parts: [{ type: "text", text: request.renderedPrompt }],
            });
        }
        catch {
            // Best-effort: the steering context is informational; the next
            // ordinary turn will already carry the relevant reminders.
        }
    }
    function pushNotification(sessionKey, level, message) {
        const ctxState = contextState();
        const sessionID = sessionIDForKey(sessionKey) ?? ctxState.activeSessionID;
        if (!sessionID)
            return;
        ctxState.notifications.push({ sessionID, level, message });
    }
    async function collectCompletionEvidence(goal) {
        const ctxState = contextState();
        const sessionID = sessionIDForKey(goal.sessionKey) ?? ctxState.activeSessionID;
        if (!sessionID)
            return undefined;
        const messages = await readOpencodeSessionMessages({ client: currentClient(), sessionID });
        return buildOpencodeCompletionEvidence(goal.objective, messages, ctxState.activeCwd);
    }
    function buildCompletionPolicyContext(goal) {
        const ctxState = contextState();
        const cwd = ctxState.activeCwd;
        const hasOpenSpec = fs.existsSync(`${cwd}/openspec/project.md`) || fs.existsSync(`${cwd}/openspec/specs`);
        if (!hasOpenSpec && !/openspec/i.test(goal.objective))
            return undefined;
        return {
            source: "opencode-adapter-openspec-policy-context",
            openspecWorkspaceDetected: hasOpenSpec,
            guidance: [
                "If this goal executes an OpenSpec change, completion evidence should include finished tasks and relevant openspec validation.",
                "If this goal closes or archives a change, completion evidence should include archive-preflight/readiness results.",
                "OpenSpec remains the planning/specification source of truth; /goal is only the execution persistence layer.",
            ],
        };
    }
    function currentClient() {
        return globalOpencodeClient;
    }
}
let globalOpencodeClient = {
    session: {},
};
export function setOpencodeClientForTests(client) {
    globalOpencodeClient = client;
}
export function resetOpencodeClientForTests() {
    globalOpencodeClient = { session: {} };
}
export const opencodeGoalPlugin = async (input) => {
    globalOpencodeClient = input.client;
    const ctx = createOpencodeGoalPluginContext();
    ctx.activeCwd = input.directory ?? input.worktree ?? process.cwd();
    return buildOpencodePluginHooks(ctx, input);
};
function buildOpencodePluginHooks(ctx, input) {
    const tool = {};
    tool.get_goal = {
        description: "Get the current goal for this OpenCode session, including status, budget, usage, and elapsed time.",
        args: {},
        async execute(_args, toolCtx) {
            const sessionID = toolCtx?.sessionID ?? ctx.activeSessionID;
            if (!sessionID)
                return "No opencode session is active.";
            const result = await ctx.runtime.toolGetGoal(sessionKeyForID(sessionID));
            return result.message;
        },
    };
    tool.create_goal = {
        description: "Create a goal only when explicitly requested by the user/system/developer context and no goal currently exists. Do not infer goals from ordinary tasks.",
        args: {
            objective: z.string().describe("Concrete objective to pursue."),
            token_budget: z.number().int().positive().optional().describe("Optional positive token budget."),
        },
        async execute(args, toolCtx) {
            const sessionID = toolCtx?.sessionID ?? ctx.activeSessionID;
            if (!sessionID)
                return "No opencode session is active.";
            const result = await ctx.runtime.toolCreateGoal(sessionKeyForID(sessionID), args.objective, args.token_budget);
            return result.message;
        },
    };
    tool.update_goal = {
        description: "Update the existing goal. Use complete only when the full objective is achieved and verified. Use blocked only when the same blocking condition has repeated for at least three consecutive goal turns and meaningful progress is impossible without user input or external state change.",
        args: {
            status: z.enum(["complete", "blocked"]),
        },
        async execute(args, toolCtx) {
            const sessionID = toolCtx?.sessionID ?? ctx.activeSessionID;
            if (!sessionID)
                return "No opencode session is active.";
            const sessionKey = sessionKeyForID(sessionID);
            const current = await ctx.runtime.getGoal(sessionKey);
            let blockedAuditEvidence;
            if (args.status === "blocked" && current.goal) {
                blockedAuditEvidence = await buildBlockedAuditEvidenceForSession(sessionID, current.goal);
            }
            try {
                const result = await ctx.runtime.toolUpdateGoal(sessionKey, args.status, { blockedAuditEvidence });
                return result.message;
            }
            catch (error) {
                return `update_goal rejected: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    };
    tool[OPENCODE_GOAL_TOOL] = {
        description: formatOpencodeGoalToolDescription(),
        args: {
            command: z.string().describe("Full /goal argument string after the slash, e.g. 'migrate to v2' or 'list'."),
        },
        async execute(args, toolCtx) {
            const sessionID = toolCtx?.sessionID ?? ctx.activeSessionID;
            if (!sessionID)
                return "No opencode session is active.";
            return runOpencodeGoalCommand(ctx, input, sessionID, args.command ?? "");
        },
    };
    return {
        tool: tool,
        event: async ({ event }) => {
            const sessionID = extractOpencodeEventSessionID(event);
            if (!sessionID)
                return;
            if (event.type === "session.created") {
                ctx.activeSessionID = sessionID;
                ctx.activeCwd = event.properties?.info?.directory ?? ctx.activeCwd;
                const result = await ctx.runtime.getGoal(sessionKeyForID(sessionID));
                if (result.goal)
                    ctx.goalBySessionKey.set(sessionKeyForID(sessionID), goalToSummary(result.goal));
                const next = (await ctx.runtime.getGoal(sessionKeyForID(sessionID))).goal;
                ctx.lastGoalSummary.set(sessionID, compactGoalStatus(next));
                return;
            }
            if (isOpencodeSessionIdleEvent(event) || isOpencodeSessionCompactedEvent(event)) {
                const messages = await readOpencodeSessionMessages({ client: input.client, sessionID });
                const usage = readOpencodeTokenUsage(messages);
                await ctx.runtime.turnFinished({ sessionKey: sessionKeyForID(sessionID), tokenUsage: usage }, true);
                ctx.busySessions.delete(sessionID);
                return;
            }
            if (isOpencodeSessionErrorEvent(event)) {
                const messages = await readOpencodeSessionMessages({ client: input.client, sessionID });
                const usage = readOpencodeTokenUsage(messages);
                const current = await ctx.runtime.getGoal(sessionKeyForID(sessionID));
                if (current.goal?.status === "active") {
                    await ctx.runtime.pauseGoal(sessionKeyForID(sessionID));
                }
                await ctx.runtime.turnFinished({ sessionKey: sessionKeyForID(sessionID), tokenUsage: usage }, false);
                ctx.busySessions.delete(sessionID);
            }
        },
        "command.execute.before": async (commandInput) => {
            if (commandInput.command !== OPENCODE_GOAL_SLASH)
                return;
            ctx.notifications.push({
                sessionID: commandInput.sessionID,
                level: "info",
                message: `/goal ${commandInput.arguments}`.trim(),
            });
        },
        "tool.execute.before": async (toolInput, output) => {
            const stop = ctx.runtime.getCurrentTurnStop(sessionKeyForID(toolInput.sessionID));
            const toolName = toolInput.tool;
            if (stop && !POST_STOP_ALLOWED_TOOL_SET.has(toolName)) {
                output.args = undefined;
                ctx.notifications.push({
                    sessionID: toolInput.sessionID,
                    level: "warning",
                    message: `Blocked tool call ${toolName}: the active goal already stopped this turn (${stop.reason}).`,
                });
                return;
            }
            if (toolName === "get_goal" || toolName === "create_goal" || toolName === "update_goal" || toolName === OPENCODE_GOAL_TOOL)
                return;
            ctx.busySessions.add(toolInput.sessionID);
        },
        "tool.execute.after": async (toolInput) => {
            const toolName = toolInput.tool;
            if (toolName === "get_goal" || toolName === "create_goal" || toolName === "update_goal" || toolName === OPENCODE_GOAL_TOOL)
                return;
            const isError = Boolean(toolInput.args?.isError);
            const usage = await readOpencodeTokenUsageForSession(toolInput.sessionID);
            await ctx.runtime.toolCompleted({
                sessionKey: sessionKeyForID(toolInput.sessionID),
                tokenUsage: usage,
                toolName,
                meaningfulProgress: !isError && toolName !== undefined ? isMeaningfulProgressTool(toolName) : false,
                progressSummary: isError ? `${toolName ?? "unknown"} failed` : toolName,
            });
            ctx.busySessions.delete(toolInput.sessionID);
        },
        "experimental.chat.messages.transform": async (_transformInput, output) => {
            const sessionID = ctx.activeSessionID;
            if (!sessionID)
                return;
            const goal = (await ctx.runtime.getGoal(sessionKeyForID(sessionID))).goal;
            const isCurrent = (metadata) => Boolean(goal && goal.status === "active" && metadata.goalId === goal.goalId);
            const rewritten = rewriteOpencodeQueuedContinuations(output.messages, isCurrent, goal?.goalId);
            if (rewritten.changed)
                output.messages = rewritten.messages;
        },
        "experimental.chat.system.transform": async (_transformInput, output) => {
            const sessionID = ctx.activeSessionID;
            if (!sessionID)
                return;
            const goal = (await ctx.runtime.getGoal(sessionKeyForID(sessionID))).goal;
            if (!goal || goal.status !== "active")
                return;
            output.system = [...output.system, renderActiveGoalReminderPrompt(goal)];
        },
    };
}
function isMeaningfulProgressTool(toolName) {
    return MEANINGFUL_PROGRESS_TOOL_SET.has(toolName);
}
async function runOpencodeGoalCommand(ctx, input, sessionID, rawArgs) {
    const parsed = parseOpencodeGoalCommand(rawArgs);
    if (parsed.kind === "invalid") {
        return `/goal rejected: ${parsed.error ?? "unrecognised arguments"}`;
    }
    const sessionKey = sessionKeyForID(sessionID);
    if (parsed.kind === "show") {
        const result = await ctx.runtime.getGoal(sessionKey);
        return result.message;
    }
    if (parsed.kind === "subcommand") {
        return runOpencodeGoalSubcommand(ctx, sessionKey, parsed);
    }
    if (parsed.kind === "edit") {
        const goal = await ctx.runtime.getGoal(sessionKey);
        if (!goal.goal)
            return "No active goal to edit. Use /goal <objective> to start one.";
        const next = parsed.remaining.trim() || goal.goal.objective;
        const result = await ctx.runtime.executeParsedCommand(sessionKey, parseGoalCommand(`edit ${next}`));
        return result.message;
    }
    if (parsed.kind === "budget") {
        return runOpencodeGoalBudget(ctx, sessionKey, parsed.remaining.trim());
    }
    // kind === "start"
    return runOpencodeGoalStart(ctx, input, sessionID, parsed);
}
async function runOpencodeGoalSubcommand(ctx, sessionKey, parsed) {
    const subcommand = parsed.subcommand;
    const ref = parsed.remaining.replace(subcommand, "").trim() || undefined;
    const goal = await resolveGoalReference(ctx, sessionKey, ref);
    switch (subcommand) {
        case "list": {
            const summaries = await ctx.runtime.listGoalSummaries();
            return summaries.length === 0 ? "No goals recorded." : summaries.map(formatGoalListLine).join("\n");
        }
        case "status": {
            const detail = await formatOpencodeGoalStatus(ctx, goal);
            return detail;
        }
        case "monitor": {
            return await monitorOpencodeGoal(ctx, goal);
        }
        case "pause":
        case "resume":
        case "clear": {
            const result = await ctx.runtime.executeParsedCommand(goal.sessionKey, parseGoalCommand(subcommand), { confirmReplace: true });
            return result.message;
        }
        case "edit":
        case "budget": {
            return `/goal ${subcommand} requires the goal_command tool to capture interactive input. Try /goal ${subcommand} <value> instead.`;
        }
    }
}
async function runOpencodeGoalBudget(ctx, sessionKey, args) {
    const tokens = args.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0] === "") {
        return "/goal budget requires a positive token budget like '100k' or '1.5m'.";
    }
    if (tokens.length > 2) {
        return "/goal budget accepts at most one goal-ref and one token-budget.";
    }
    const [first, second] = tokens;
    let ref;
    let budget;
    if (second) {
        ref = first;
        budget = second;
    }
    else {
        budget = first;
    }
    const goal = await resolveGoalReference(ctx, sessionKey, ref);
    const result = await ctx.runtime.executeParsedCommand(goal.sessionKey, parseGoalCommand(`edit --tokens ${budget} ${goal.objectiveSummary}`), { confirmReplace: true });
    return result.message;
}
async function runOpencodeGoalStart(ctx, input, sessionID, parsed) {
    const sessionKey = sessionKeyForID(sessionID);
    const flags = parsed.workspace;
    const dagSourceFile = flags.dagFile ? resolve(ctx.activeCwd, flags.dagFile) : undefined;
    const dagDocument = dagSourceFile ? parseGoalDagFileContent(fs.readFileSync(dagSourceFile, "utf8")) : undefined;
    const inlineModelRouting = flags.modelRoutingJson
        ? readOpencodeModelRoutingConfig({ inlineJson: flags.modelRoutingJson, cwd: ctx.activeCwd })
        : flags.modelRoutingFile
            ? readOpencodeModelRoutingConfig({ filePath: flags.modelRoutingFile, cwd: ctx.activeCwd })
            : readOpencodeModelRoutingConfig({ cwd: ctx.activeCwd });
    const modelRouting = dagDocument?.modelRouting ?? inlineModelRouting;
    const objectiveText = dagDocument ? dagDocument.objective : parsed.remaining.trim();
    if (!objectiveText)
        return "/goal requires a non-empty objective.";
    let command;
    try {
        command = dagDocument
            ? { kind: "start", objective: dagDocument.objective, tokenBudget: parseOpencodeDagStartTokenBudget(flags.remainingArgs) }
            : parseGoalCommand(parsed.remaining);
    }
    catch (error) {
        return `/goal rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (command.kind !== "start")
        return `/goal ${command.kind} requires the explicit command form.`;
    const binding = flags.workspace
        ? resolveWorkspaceBinding(flags, ctx.activeCwd)
        : allocateOpencodeControllerWorkspace(ctx, command.objective, flags.branch ?? flags.ref);
    const validation = validateExecutionWorkspace(binding);
    if (!validation.ok)
        return `/goal rejected: ${validation.message ?? "execution workspace validation failed"}`;
    if (!validation.isGit)
        return "/goal orchestration requires a git workspace";
    return startOpencodeOrchestratedGoal(ctx, input, sessionID, command, binding, validation, {
        dagDocument: dagDocument,
        dagSourceFile,
        modelRouting: modelRouting,
    });
}
function parseOpencodeDagStartTokenBudget(args) {
    const tokens = tokenize(args);
    if (tokens.length === 0)
        return undefined;
    if (tokens.length === 2 && tokens[0] === "--tokens")
        return parseTokenBudget(tokens[1] ?? "");
    throw new Error("/goal --dag accepts only --tokens as an additional start flag; objective must come from the DAG file");
}
async function startOpencodeOrchestratedGoal(ctx, input, sessionID, command, binding, validation, options = {}) {
    const originSessionKey = sessionKeyForID(sessionID);
    const goalId = `goal-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const executionSessionKey = `opencode:${goalId}`;
    const objective = options.dagDocument ? options.dagDocument.objective : command.objective;
    const created = await ctx.runtime.createOrReplaceGoal(executionSessionKey, objective, { tokenBudget: command.tokenBudget });
    if (!created.goal)
        return created.message;
    const goal = created.goal;
    const modelRouting = options.modelRouting ?? options.dagDocument?.modelRouting ?? readOpencodeModelRoutingConfig({});
    const controllerModel = resolveOpencodeControllerModel(modelRouting);
    const adapter = new OpencodeHarnessSubagentAdapter({ modelArg: controllerModel.model });
    await ctx.runtime.saveGoalSessionMetadata({
        sessionKey: executionSessionKey,
        goalId: goal.goalId,
        originSessionKey,
        executionWorkspace: binding.workspace,
        workspaceStatus: validation.workspaceStatus,
        branch: binding.branch,
        ref: binding.ref,
        branchVerificationStatus: validation.branchVerificationStatus,
        controllerModelScenario: controllerModel.scenario,
        controllerModelClass: controllerModel.modelClass,
        controllerModelArg: controllerModel.model,
        controllerModelResolution: controllerModel.evidence,
        createdAt: goal.createdAt,
        updatedAt: new Date().toISOString(),
    });
    const existingNodes = await ctx.runtime.listGoalDagNodes(goal.goalId);
    const planned = options.dagDocument
        ? { nodes: await ctx.runtime.planGoalDagFromFileDocument(goal.goalId, options.dagDocument, {
                defaultWorkspaceStrategy: "native-git-worktree",
                defaultCompletionGates: ["controller-validation"],
            }).then((result) => result.nodes) }
        : existingNodes.length > 0
            ? { nodes: existingNodes }
            : await ctx.runtime.planGoalDagFromObjective(goal.goalId, goal.objective, {
                defaultWorkspaceStrategy: "native-git-worktree",
                defaultCompletionGates: ["controller-validation"],
            });
    const workspaceManager = new NativeGitWorkspaceManager({ defaultBaseRef: binding.branch ?? binding.ref, fetch: false });
    await ctx.runtime.runGoalControllerLoop(goal.goalId, {
        adapter,
        maxTicks: 1,
        intervalMs: 0,
        schedulingPolicy: { maxConcurrentSubagents: readOpencodeMaxSubagents() },
        workspaceAllocator: async (request) => {
            const allocation = (await createNativeGitSubagentWorkspaceAllocator(workspaceManager, {
                controllerWorkspacePath: binding.workspace,
                baseRef: binding.branch ?? binding.ref,
                metadata: { controllerGoalId: goal.goalId },
            })(request)) ?? {};
            const selection = selectOpencodeSubagentModel(request.node, modelRouting);
            return {
                ...allocation,
                metadata: {
                    ...(allocation?.metadata ?? {}),
                    controllerGoalId: goal.goalId,
                    modelArg: selection.model,
                    modelScenario: selection.scenario,
                    modelClass: selection.modelClass,
                    modelResolution: selection.evidence,
                    modelScenarioReason: selection.reason,
                },
            };
        },
        validator: createControllerValidationRunner(),
        audit: controllerAuditOptions(),
        auditModel: createAuditModel(),
        integrator: createNativeGitSubagentBranchIntegrator(workspaceManager, { controllerWorkspacePath: binding.workspace }),
        metadata: {
            controllerGoalId: goal.goalId,
            controllerModel: controllerModel.model,
            controllerModelScenario: controllerModel.scenario,
            controllerModelClass: controllerModel.modelClass,
            controllerModelResolution: controllerModel.evidence,
        },
    });
    startOpencodeControllerPolling(ctx, input, goal, binding);
    const dagNote = options.dagSourceFile ? ` DAG: ${options.dagSourceFile}.` : "";
    return [
        `Goal ${goal.goalId.slice(0, 8)} started.`,
        `Workspace: ${binding.workspace}${validation.currentBranch ? ` (branch=${validation.currentBranch})` : ""}.${dagNote}`,
        `Planned ${planned.nodes.length} DAG node(s); controller loop is supervising detached opencode subagent sessions.`,
        `Controller model: ${controllerModel.model} via ${controllerModel.modelClass} (${controllerModel.reason}).`,
        `Use /goal status ${goal.goalId.slice(0, 8)} or /goal monitor to inspect it.`,
    ].join("\n");
}
function allocateOpencodeControllerWorkspace(ctx, objective, baseRef) {
    const allocation = new NativeGitWorkspaceManager({ defaultBaseRef: baseRef, fetch: false }).allocateControllerWorkspace({
        invocationCwd: ctx.activeCwd,
        goalId: `goal-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        objective,
        baseRef,
    });
    return { workspace: allocation.worktreePath, branch: allocation.branch };
}
function startOpencodeControllerPolling(ctx, input, goal, binding) {
    const pollMs = readOpencodeControllerPollMs();
    if (pollMs <= 0 || ctx.backgroundPollers.has(goal.goalId))
        return;
    const timer = setInterval(() => {
        void runOpencodeControllerPoll(ctx, input, goal, binding).catch(() => undefined);
    }, pollMs);
    timer.unref?.();
    ctx.backgroundPollers.set(goal.goalId, timer);
}
async function runOpencodeControllerPoll(ctx, input, goal, binding) {
    if (await shouldStopOpencodeControllerPolling(ctx, goal.goalId)) {
        stopOpencodeControllerPolling(ctx, goal.goalId);
        return;
    }
    const workspaceManager = new NativeGitWorkspaceManager({ defaultBaseRef: binding.branch ?? binding.ref, fetch: false });
    const modelRouting = readOpencodeModelRoutingConfig({});
    await ctx.runtime.runGoalControllerLoop(goal.goalId, {
        adapter: ctx.subagentAdapter,
        maxTicks: 1,
        intervalMs: 0,
        schedulingPolicy: { maxConcurrentSubagents: readOpencodeMaxSubagents() },
        workspaceAllocator: async (request) => {
            const allocation = (await createNativeGitSubagentWorkspaceAllocator(workspaceManager, {
                controllerWorkspacePath: binding.workspace,
                baseRef: binding.branch ?? binding.ref,
                metadata: { controllerGoalId: goal.goalId },
            })(request)) ?? {};
            const selection = selectOpencodeSubagentModel(request.node, modelRouting);
            return {
                ...allocation,
                metadata: {
                    ...(allocation?.metadata ?? {}),
                    controllerGoalId: goal.goalId,
                    modelArg: selection.model,
                    modelScenario: selection.scenario,
                    modelClass: selection.modelClass,
                    modelResolution: selection.evidence,
                    modelScenarioReason: selection.reason,
                },
            };
        },
        validator: createControllerValidationRunner(),
        audit: controllerAuditOptions(),
        auditModel: createAuditModel(),
        integrator: createNativeGitSubagentBranchIntegrator(workspaceManager, { controllerWorkspacePath: binding.workspace }),
        metadata: { controllerGoalId: goal.goalId },
    });
    if (await shouldStopOpencodeControllerPolling(ctx, goal.goalId)) {
        const closeout = await finalizeOpencodeGoalFromDagTerminalState(ctx.runtime, goal.goalId, binding, {
            stopBackgroundSession: () => {
                const handle = ctx.backgroundSessions.get(goal.goalId);
                handle?.stop();
                ctx.backgroundSessions.delete(goal.goalId);
            },
        });
        const diagSessionID = sessionIDForKey(`opencode:${goal.goalId}`) ?? ctx.activeSessionID;
        if (diagSessionID) {
            for (const line of formatOpencodeCloseoutDiagnostics(closeout, goal.goalId.slice(0, 8))) {
                ctx.notifications.push({ sessionID: diagSessionID, level: "warning", message: line });
            }
        }
        // Unused reference kept for tree-shake parity.
        void cleanupTerminalSubagentWorkspaces;
        stopOpencodeControllerPolling(ctx, goal.goalId);
    }
}
async function shouldStopOpencodeControllerPolling(ctx, goalId) {
    const state = await ctx.runtime.getGoalOrchestrationState(goalId);
    if (state.nodes.length === 0)
        return true;
    return state.nodes.every((node) => ["complete", "blocked", "failed", "superseded"].includes(node.status));
}
function stopOpencodeControllerPolling(ctx, goalId) {
    const timer = ctx.backgroundPollers.get(goalId);
    if (!timer)
        return;
    clearInterval(timer);
    ctx.backgroundPollers.delete(goalId);
}
function stopAllOpencodeControllerPolling(ctx) {
    for (const timer of ctx.backgroundPollers.values())
        clearInterval(timer);
    ctx.backgroundPollers.clear();
}
function readOpencodeControllerPollMs() {
    const raw = process.env.AGENT_GOAL_OPENCODE_CONTROLLER_POLL_MS ?? process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    if (raw === "0" || raw === "off")
        return 0;
    if (!raw)
        return 5_000;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
}
function readOpencodeMaxSubagents() {
    const raw = process.env.AGENT_GOAL_OPENCODE_MAX_SUBAGENTS ?? process.env.AGENT_GOAL_PI_MAX_SUBAGENTS;
    if (!raw)
        return 1;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
async function readOpencodeTokenUsageForSession(sessionID) {
    const messages = await readOpencodeSessionMessages({ client: globalOpencodeClient, sessionID });
    const usage = readOpencodeTokenUsage(messages);
    if (!usage.totalTokens && !usage.inputTokens && !usage.outputTokens)
        return undefined;
    return {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
    };
}
async function buildBlockedAuditEvidenceForSession(sessionID, goal) {
    const messages = await readOpencodeSessionMessages({ client: globalOpencodeClient, sessionID });
    return buildOpencodeBlockedAuditEvidence({
        messages,
        threshold: 3,
        goalCreatedAt: goal.createdAt,
    });
}
function sessionKeyForID(sessionID) {
    return sessionID ? `opencode:${sessionID}` : "opencode:ephemeral";
}
function sessionIDForKey(sessionKey) {
    if (!sessionKey.startsWith("opencode:"))
        return undefined;
    const rest = sessionKey.slice("opencode:".length);
    if (rest === "ephemeral")
        return undefined;
    return rest;
}
function goalToSummary(goal) {
    return {
        sessionKey: goal.sessionKey,
        goalId: goal.goalId,
        shortGoalId: goal.goalId.slice(0, 8),
        objective: goal.objective,
        objectiveSummary: goal.objective.length <= 80 ? goal.objective : `${goal.objective.slice(0, 77)}...`,
        status: goal.status,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        lastActivityAt: goal.updatedAt,
    };
}
async function resolveGoalReference(ctx, sessionKey, reference) {
    if (reference) {
        const resolved = await ctx.runtime.resolveGoalReference(reference);
        if (resolved.kind === "found")
            return resolved.goal;
        if (resolved.kind === "ambiguous") {
            throw new Error(`Ambiguous goal reference ${reference}: ${resolved.matches.map((m) => m.shortGoalId).join(", ")}`);
        }
        throw new Error(`Goal not found: ${reference}`);
    }
    const summaries = await ctx.runtime.listGoalSummaries();
    if (summaries.length === 0)
        throw new Error("No goals recorded");
    const sameOrigin = summaries.find((goal) => goal.originSessionKey === sessionKey || goal.sessionKey === sessionKey);
    if (sameOrigin)
        return sameOrigin;
    const nonTerminal = summaries.find((goal) => goal.status !== "complete");
    return nonTerminal ?? summaries[0];
}
function formatGoalListLine(goal) {
    const tokens = goal.tokenBudget === undefined ? String(goal.tokensUsed) : `${goal.tokensUsed}/${goal.tokenBudget}`;
    return `${goal.shortGoalId} ${goal.status} ${goal.timeUsedSeconds}s ${tokens} ${goal.executionWorkspace ?? "legacy"} — ${goal.objectiveSummary}`;
}
async function formatOpencodeGoalStatus(ctx, goal) {
    const orchestration = await ctx.runtime.getGoalOrchestrationState(goal.goalId);
    const lines = [
        `Goal ${goal.shortGoalId}`,
        `Status: ${goal.status}`,
        `Objective: ${goal.objective}`,
        `Workspace: ${goal.executionWorkspace ?? "legacy session-bound goal"}`,
        `Branch/ref: ${goal.branch ?? goal.ref ?? "not configured"}`,
        `Verification: ${goal.branchVerificationStatus ?? "unknown"}`,
    ];
    if (orchestration.nodes.length > 0) {
        lines.push("", "DAG:");
        for (const node of orchestration.nodes) {
            lines.push(`- ${node.nodeId}: ${node.status}${node.lastValidationSummary ? ` validation=${node.lastValidationSummary}` : ""}`);
        }
    }
    if (orchestration.subagents.length > 0) {
        lines.push("", "Subagents:");
        for (const sub of orchestration.subagents) {
            lines.push(`- ${sub.subagentId} (${sub.nodeId}): ${sub.status}${sub.branch ? ` branch=${sub.branch}` : ""}`);
        }
    }
    return lines.join("\n");
}
async function monitorOpencodeGoal(ctx, goal) {
    const snapshot = await readOpencodeGoalMonitorSnapshot(ctx.runtime, goal, { now: ctx.now });
    if (snapshot.lines.length === 0)
        return "monitor produced no output";
    return snapshot.lines.join("\n");
}
function compactGoalStatus(goal) {
    if (!goal)
        return "🎯 none";
    switch (goal.status) {
        case "active":
            return goal.tokenBudget === undefined
                ? `🎯 active ${goal.timeUsedSeconds}s`
                : `🎯 active ${goal.tokensUsed}/${goal.tokenBudget}`;
        case "paused":
            return "🎯 paused";
        case "blocked":
            return "🎯 blocked";
        case "budgetLimited":
            return `🎯 budget ${goal.tokensUsed}/${goal.tokenBudget ?? 0}`;
        case "usageLimited":
            return "🎯 usage limited";
        case "complete":
            return "🎯 complete";
    }
}
// Re-export the helpers used by tests / callers building TUI prompts
// for the `/goal` slash command.
export { stripSlashPrefix, parseOpencodeGoalCommand, formatOpencodeGoalToolDescription, OPENCODE_GOAL_TOOL, OPENCODE_GOAL_SLASH, summariseOpencodeSession, buildOpencodeCompletionEvidence, readOpencodeTokenUsage, };
//# sourceMappingURL=plugin.js.map