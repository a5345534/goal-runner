import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { promptIncludesExecutorGuardrails, renderExecutorGuardrailLines } from "../../core/executor-prompt.js";
import { launchPiRpcBackgroundGoalSession, } from "./background-session.js";
import { normalizePiModelArg } from "./model-args.js";
import { readPiBackgroundRunnerInventory } from "./runner-ops.js";
import { isPiGoalSessionEntryType } from "./session-store.js";
const MARKER_LINE_PREFIX = String.raw `(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?`;
const MARKER_LOOKAHEAD_PREFIX = String.raw `\n\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?`;
const RESULT_MARKER = new RegExp(`${MARKER_LINE_PREFIX}SUBAGENT_RESULT(?:\\*\\*)?\\s*:\\s*([\\s\\S]*?)(?=${MARKER_LOOKAHEAD_PREFIX}SUBAGENT_[A-Z_]+(?:\\*\\*)?\\s*:|$)`, "i");
const BLOCKED_MARKER = new RegExp(`${MARKER_LINE_PREFIX}SUBAGENT_BLOCKED(?:\\*\\*)?\\s*:\\s*([\\s\\S]*?)(?=${MARKER_LOOKAHEAD_PREFIX}SUBAGENT_[A-Z_]+(?:\\*\\*)?\\s*:|$)`, "i");
const QUESTION_MARKER = new RegExp(`${MARKER_LINE_PREFIX}SUBAGENT_QUESTION(?:\\*\\*)?\\s*:\\s*([\\s\\S]*?)(?=${MARKER_LOOKAHEAD_PREFIX}SUBAGENT_[A-Z_]+(?:\\*\\*)?\\s*:|$)`, "i");
const STATUS_BLOCKED_MARKER = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?SUBAGENT_STATUS(?:\*\*)?\s*:\s*blocked\b/i;
const DEFAULT_STALE_SUBAGENT_SESSION_MS = 10 * 60_000;
const CONTEXT_OVERFLOW_ERROR_PATTERNS = [
    /context_length_exceeded/i,
    /context window/i,
    /input exceeds/i,
    /too many tokens/i,
    /maximum context length/i,
    /reduce the length/i,
];
export class PiHarnessSubagentAdapter {
    adapterId = "pi";
    launcher;
    modelArg;
    now;
    runnerAlive;
    handles = new Map();
    constructor(options = {}) {
        this.launcher = options.launcher ?? launchPiRpcBackgroundGoalSession;
        this.modelArg = options.modelArg;
        this.now = options.now ?? (() => new Date());
        this.runnerAlive = options.runnerAlive ?? hasLiveBackgroundRunnerForSubagent;
    }
    async startSession(request) {
        const launch = launchRequestForStart(request, this.modelArg);
        const handle = await this.launcher(launch);
        try {
            await handle.sendPrompt(renderPiSubagentInitialPrompt(request));
            this.rememberHandle(request.subagentId, handle);
        }
        catch (error) {
            try {
                handle.stop();
            }
            catch { /* best-effort cleanup after failed prompt dispatch */ }
            throw error;
        }
        return {
            sessionId: handle.sessionId,
            sessionFile: handle.sessionFile,
            workspacePath: request.preparedResources?.workspacePath ?? request.cwd,
            branch: request.preparedResources?.branch ?? request.branch,
            ref: request.preparedResources?.ref ?? request.ref,
            status: "running",
            lastActivityAt: this.now().toISOString(),
            metadata: { sessionName: launch.sessionName },
        };
    }
    async sendPrompt(request) {
        const handle = await this.launchForExistingSubagent(request.subagent);
        try {
            await handle.sendPrompt(request.prompt);
        }
        catch (error) {
            this.stopExistingHandle(request.subagent);
            throw error;
        }
    }
    getSessionState(request) {
        const handle = this.handles.get(keyForSubagent(request.subagent));
        return readPiSubagentSessionState(request.subagent, {
            live: Boolean(handle?.isAlive?.()) || this.runnerAlive(request.subagent),
            now: this.now,
        });
    }
    async abortSession(request) {
        const key = keyForSubagent(request.subagent);
        const handle = this.handles.get(key);
        if (!handle)
            return;
        handle.stop();
        this.handles.delete(key);
    }
    /** Stop all tracked subagent background sessions and clear the handle map. */
    abortAll() {
        for (const [key, handle] of this.handles) {
            try {
                handle.stop();
            }
            catch { /* best-effort */ }
            this.handles.delete(key);
        }
    }
    async launchForExistingSubagent(subagent) {
        if (!subagent.sessionFile)
            throw new Error(`Pi subagent ${subagent.subagentId} has no sessionFile to resume`);
        const launch = {
            cwd: subagent.workspacePath ?? process.cwd(),
            sessionFile: subagent.sessionFile,
            sessionName: sessionNameForSubagent(subagent),
            modelArg: normalizePiModelArg(this.modelArg),
        };
        this.stopExistingHandle(subagent);
        const handle = await this.launcher(launch);
        this.rememberHandle(subagent.subagentId, handle);
        return handle;
    }
    rememberHandle(subagentId, handle) {
        this.handles.set(subagentId, handle);
    }
    stopExistingHandle(subagent) {
        const key = keyForSubagent(subagent);
        const handle = this.handles.get(key);
        if (!handle)
            return;
        handle.stop();
        this.handles.delete(key);
    }
}
export function createPiHarnessSubagentAdapter(options = {}) {
    return new PiHarnessSubagentAdapter(options);
}
export function renderPiSubagentInitialPrompt(request) {
    const lines = [
        request.systemPrompt,
        "You are a goal-orchestration subagent controlled by a parent controller.",
        "Work only on your assigned DAG node. Do not mark the parent goal complete and do not claim global completion.",
        "When your assigned node is done, report a concise result using this exact marker on its own line:",
        "SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>",
        "If blocked, report this exact marker instead:",
        "SUBAGENT_BLOCKED: <specific blocker and what input/state change is needed>",
        "If you encounter material ambiguity that could affect correctness, compatibility, scope, or validation, report your uncertainty using this marker:",
        "SUBAGENT_QUESTION:",
        "- question: <what needs to be decided>",
        "- why it matters: <correctness/scope/compatibility/validation impact>",
        "- options:",
        "  - A: <summary and tradeoff>",
        "  - B: <summary and tradeoff>",
        "- recommended default: <option id or concrete assumption>",
        "- blocking: yes|no",
        "The controller will answer from context, approve a bounded assumption, or escalate if needed.",
        "",
        `Goal: ${request.goalId}`,
        `Node: ${request.node.nodeId} (${request.node.slug})`,
        `Node objective: ${request.node.objective}`,
        request.node.scope ? `Scope: ${request.node.scope}` : undefined,
        request.cwd ? `Workspace: ${request.cwd}` : undefined,
        request.branch ? `Branch: ${request.branch}` : request.ref ? `Ref: ${request.ref}` : undefined,
        request.cwd && request.branch ? "If you change repository files, commit the intended changes on this branch before reporting SUBAGENT_RESULT; uncommitted work cannot be integrated by the controller." : undefined,
        request.node.expectedOutputs.length ? `Expected outputs: ${request.node.expectedOutputs.join(", ")}` : undefined,
        request.node.validators.length ? `Validators: ${request.node.validators.join(", ")}` : undefined,
        "",
        ...(promptIncludesExecutorGuardrails(request.initialPrompt) ? [] : renderExecutorGuardrailLines(request.node)),
        "",
        request.initialPrompt,
    ];
    return lines.filter((line) => Boolean(line && line.trim())).join("\n");
}
export function readPiSubagentSessionState(subagent, options = {}) {
    const sessionFile = subagent.sessionFile;
    const exists = options.exists ?? existsSync;
    if (!sessionFile) {
        return { status: "failed", error: `Pi subagent ${subagent.subagentId} has no sessionFile` };
    }
    if (!exists(sessionFile)) {
        return { status: options.live ? "starting" : "failed", error: `Pi subagent session file not found: ${sessionFile}` };
    }
    const parsed = options.readFile ? parsePiSessionFile(options.readFile(sessionFile)) : parsePiSessionFileFromDisk(sessionFile);
    const currentAttemptAt = currentAttemptCutoffAt(subagent);
    const effectiveLastActivityAt = maxIso(parsed.lastActivityAt, currentAttemptAt);
    const assistantIsCurrent = isAtOrAfter(parsed.lastAssistantAt, currentAttemptAt);
    const staleResult = !assistantIsCurrent ? extractResultMarker(parsed.lastAssistantText) : undefined;
    const staleBlocked = !assistantIsCurrent ? extractBlockedMarker(parsed.lastAssistantText) : undefined;
    const hasExplicitAttempt = Boolean(subagent.attemptId || subagent.attemptStartedAt || subagent.attemptCursor);
    const errorIsCurrent = Boolean(parsed.lastError && (!hasExplicitAttempt || isAtOrAfter(parsed.lastErrorAt ?? parsed.lastActivityAt, currentAttemptAt)));
    const attemptMetadata = compactMetadata({
        attemptId: subagent.attemptId,
        attemptStartedAt: subagent.attemptStartedAt,
        attemptCursorAt: hasExplicitAttempt ? currentAttemptAt : undefined,
        staleReplayIgnored: Boolean(staleResult || staleBlocked),
        staleReplayMarker: staleResult ? "SUBAGENT_RESULT" : staleBlocked ? "SUBAGENT_BLOCKED" : undefined,
        staleReplayAt: staleResult || staleBlocked ? parsed.lastAssistantAt : undefined,
        staleErrorIgnored: Boolean(parsed.lastError && !errorIsCurrent),
        staleErrorAt: parsed.lastError && !errorIsCurrent ? parsed.lastErrorAt : undefined,
    });
    const blocked = assistantIsCurrent ? extractBlockedMarker(parsed.lastAssistantText) : undefined;
    if (blocked) {
        return withInspectionMetadata({ status: "blocked", selfReportedResult: blocked, lastActivityAt: parsed.lastAssistantAt ?? effectiveLastActivityAt }, parsed, attemptMetadata);
    }
    const result = assistantIsCurrent ? extractResultMarker(parsed.lastAssistantText) : undefined;
    if (result) {
        return withInspectionMetadata({ status: "selfReportedComplete", selfReportedResult: result, lastActivityAt: parsed.lastAssistantAt ?? effectiveLastActivityAt }, parsed, attemptMetadata);
    }
    // SUBAGENT_QUESTION detection: if the subagent surfaced a question, report as needsFollowup
    // so the controller can triage it. The question body is stored in selfReportedResult for
    // downstream triage logic to parse.
    const question = assistantIsCurrent ? extractQuestionMarkerFromPi(parsed.lastAssistantText) : undefined;
    if (question) {
        return withInspectionMetadata({ status: "needsFollowup", selfReportedResult: `SUBAGENT_QUESTION: ${question}`, lastActivityAt: parsed.lastAssistantAt ?? effectiveLastActivityAt }, parsed, attemptMetadata);
    }
    if (parsed.lastError && errorIsCurrent) {
        if (isRecoverableContextOverflow(parsed, options, effectiveLastActivityAt)) {
            return withInspectionMetadata({ status: "running", error: `Pi context overflow recovery pending: ${parsed.lastError}`, lastActivityAt: effectiveLastActivityAt }, parsed, attemptMetadata);
        }
        return withInspectionMetadata({ status: "failed", error: parsed.lastError, lastActivityAt: effectiveLastActivityAt }, parsed, attemptMetadata);
    }
    const terminalish = parsed.lastMessageRole === "assistant" && assistantIsCurrent ? terminalishAssistantTextWithoutMarker(parsed.lastAssistantText) : undefined;
    if (terminalish) {
        return withInspectionMetadata({ status: "needsFollowup", selfReportedResult: terminalish, lastActivityAt: parsed.lastAssistantAt ?? effectiveLastActivityAt }, parsed, attemptMetadata);
    }
    const staleReason = staleUnresolvedSessionReason(parsed, options, effectiveLastActivityAt, currentAttemptAt);
    if (staleReason) {
        return withInspectionMetadata({ status: "needsFollowup", error: staleReason, lastActivityAt: effectiveLastActivityAt }, parsed, attemptMetadata);
    }
    const status = parsed.lastMessageRole === "assistant" ? "idle" : options.live ? "running" : "idle";
    return withInspectionMetadata({ status, lastActivityAt: effectiveLastActivityAt }, parsed, attemptMetadata);
}
function parsePiSessionFile(content) {
    const parsed = { entryCount: 0, messageCount: 0 };
    for (const rawLine of content.split("\n"))
        parsePiSessionLine(rawLine, parsed);
    return parsed;
}
function parsePiSessionFileFromDisk(path) {
    const parsed = { entryCount: 0, messageCount: 0 };
    const fd = openSync(path, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let carry = "";
    try {
        while (true) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead <= 0)
                break;
            carry += decoder.write(buffer.subarray(0, bytesRead));
            let newlineIndex = carry.indexOf("\n");
            while (newlineIndex >= 0) {
                parsePiSessionLine(carry.slice(0, newlineIndex), parsed);
                carry = carry.slice(newlineIndex + 1);
                newlineIndex = carry.indexOf("\n");
            }
        }
        carry += decoder.end();
        if (carry.trim())
            parsePiSessionLine(carry, parsed);
    }
    finally {
        closeSync(fd);
    }
    return parsed;
}
function parsePiSessionLine(rawLine, parsed) {
    if (!rawLine.trim())
        return;
    if (looksLikeRuntimeStateMirrorLine(rawLine)) {
        parsed.entryCount += 1;
        return;
    }
    let entry;
    try {
        entry = JSON.parse(rawLine);
    }
    catch {
        parsed.lastError = "Malformed Pi session entry";
        return;
    }
    parsed.entryCount += 1;
    if (isRuntimeStateMirrorEntry(entry))
        return;
    if (typeof entry.timestamp === "string")
        parsed.lastActivityAt = entry.timestamp;
    if (entry.type === "compaction") {
        // Pi writes compaction entries after context-overflow assistant errors and then
        // rebuilds/retries the session. Treat a later compaction as recovery evidence
        // so the pre-compaction error does not remain sticky in runtime polling.
        parsed.lastError = undefined;
        parsed.lastErrorAt = undefined;
        parsed.lastMessageRole = "compaction";
        return;
    }
    if (entry.type !== "message")
        return;
    parsed.messageCount += 1;
    const message = entry.message;
    if (!message)
        return;
    if (typeof message.role === "string")
        parsed.lastMessageRole = message.role;
    if (message.role === "assistant") {
        if (message.stopReason === "error" && typeof message.errorMessage === "string") {
            parsed.lastError = message.errorMessage;
            parsed.lastErrorAt = typeof entry.timestamp === "string" ? entry.timestamp : parsed.lastActivityAt;
        }
        else {
            parsed.lastError = undefined;
            parsed.lastErrorAt = undefined;
        }
        const assistantText = textFromContent(message.content);
        if (assistantText) {
            parsed.lastAssistantText = assistantText;
            if (typeof entry.timestamp === "string")
                parsed.lastAssistantAt = entry.timestamp;
        }
    }
}
function looksLikeRuntimeStateMirrorLine(rawLine) {
    return rawLine.includes('"custom"') && (rawLine.includes('"goal-runner-state"') || rawLine.includes('"agent-goal-runtime-state"'));
}
function isRuntimeStateMirrorEntry(entry) {
    return (entry.type === "custom" || entry.type === "custom_message") && isPiGoalSessionEntryType(entry.customType);
}
function withInspectionMetadata(state, parsed, extra = {}) {
    return { ...state, metadata: { ...(state.metadata ?? {}), entryCount: parsed.entryCount, messageCount: parsed.messageCount, ...extra } };
}
function compactMetadata(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== false));
}
function launchRequestForStart(request, modelArg) {
    return {
        cwd: request.preparedResources?.workspacePath ?? request.cwd ?? process.cwd(),
        sessionId: request.preparedResources?.sessionId ?? (request.preparedResources?.sessionFile ? undefined : piSessionId(request.subagentId)),
        sessionFile: request.preparedResources?.sessionFile,
        sessionName: metadataString(request.metadata, "sessionName") ?? `subagent ${request.subagentId}: ${request.node.slug}`,
        modelArg: normalizePiModelArg(request.preparedResources?.modelArg ?? metadataString(request.metadata, "modelArg") ?? modelArg),
        thinkingLevel: request.preparedResources?.thinkingLevel ?? metadataString(request.metadata, "thinkingLevel"),
    };
}
function piSessionId(subagentId) {
    const normalized = normalizePiSessionId(`subagent-${subagentId}`);
    if (normalized.length <= 64)
        return normalized || "subagent";
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
    const tail = normalizePiSessionId(normalized.slice(-20)) || hash;
    const prefixLength = Math.max(1, 64 - hash.length - tail.length - 2);
    const prefix = normalizePiSessionId(normalized.slice(0, prefixLength)) || "subagent";
    return normalizePiSessionId(`${prefix}-${hash}-${tail}`).slice(0, 64).replace(/[^a-zA-Z0-9]+$/g, "") || `subagent-${hash}`;
}
function normalizePiSessionId(value) {
    return value
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
}
function sessionNameForSubagent(subagent) {
    return `subagent ${subagent.subagentId}: ${subagent.nodeId}`;
}
function keyForSubagent(subagent) {
    return subagent.subagentId;
}
function hasLiveBackgroundRunnerForSubagent(subagent) {
    return readPiBackgroundRunnerInventory(subagent.goalId, [subagent]).some((record) => record.subagentId === subagent.subagentId && (record.runnerAlive || record.childAlive));
}
function metadataString(metadata, key) {
    const value = metadata?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}
export function extractQuestionMarkerFromPi(text) {
    const match = text?.match(QUESTION_MARKER);
    return cleanupMarkerText(match?.[1]);
}
function extractResultMarker(text) {
    const match = text?.match(RESULT_MARKER);
    return cleanupMarkerText(match?.[1]);
}
function extractBlockedMarker(text) {
    const explicit = cleanupMarkerText(text?.match(BLOCKED_MARKER)?.[1]);
    if (explicit)
        return explicit;
    return STATUS_BLOCKED_MARKER.test(text ?? "") ? "Subagent reported blocked" : undefined;
}
function terminalishAssistantTextWithoutMarker(text) {
    const cleaned = cleanupMarkerText(text);
    if (!cleaned)
        return undefined;
    if (RESULT_MARKER.test(cleaned) || BLOCKED_MARKER.test(cleaned) || STATUS_BLOCKED_MARKER.test(cleaned))
        return undefined;
    const successLike = /(\bdone\b|\bcompleted\b|\bfinished\b|\bimplemented\b|verification passed|validation passed|tests? passed|已完成|完成到目前|驗證.*通過|測試.*通過|已處理)/i.test(cleaned);
    const blockedLike = /(\bblocked\b|cannot complete|can't complete|unable to complete|無法完成|阻塞|卡住)/i.test(cleaned);
    return successLike || blockedLike ? cleaned : undefined;
}
function isRecoverableContextOverflow(parsed, options, effectiveLastActivityAt) {
    if (!parsed.lastError || !isContextOverflowError(parsed.lastError))
        return false;
    if (options.live !== true)
        return false;
    const lastActivity = effectiveLastActivityAt ?? parsed.lastActivityAt;
    if (!lastActivity)
        return true;
    const lastMs = Date.parse(lastActivity);
    if (!Number.isFinite(lastMs))
        return true;
    const nowMs = (options.now?.() ?? new Date()).getTime();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_SUBAGENT_SESSION_MS;
    return nowMs - lastMs < staleAfterMs;
}
function isContextOverflowError(message) {
    return CONTEXT_OVERFLOW_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
function staleUnresolvedSessionReason(parsed, options, effectiveLastActivityAt, currentAttemptAt) {
    const role = parsed.lastMessageRole;
    if (!role)
        return undefined;
    const lastActivity = effectiveLastActivityAt ?? parsed.lastActivityAt;
    if (options.live === false)
        return `stale-subagent-session: background runner is not live; last message role=${role}${lastActivity ? ` at ${lastActivity}` : ""}`;
    if (!lastActivity)
        return undefined;
    const lastMs = Date.parse(lastActivity);
    if (!Number.isFinite(lastMs))
        return undefined;
    const nowMs = (options.now?.() ?? new Date()).getTime();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_SUBAGENT_SESSION_MS;
    if (nowMs - lastMs < staleAfterMs)
        return undefined;
    const ageSeconds = Math.max(0, Math.floor((nowMs - lastMs) / 1000));
    if (currentAttemptAt && isBefore(parsed.lastActivityAt, currentAttemptAt)) {
        return `stale-subagent-session: no current-attempt transcript activity for ${ageSeconds}s after prompt at ${currentAttemptAt}`;
    }
    if (role === "assistant") {
        return `stale-subagent-session: unresolved assistant message without SUBAGENT_RESULT/SUBAGENT_BLOCKED for ${ageSeconds}s at ${lastActivity}`;
    }
    return `stale-subagent-session: no transcript activity for ${ageSeconds}s after last message role=${role} at ${lastActivity}`;
}
function currentAttemptCutoffAt(subagent) {
    const cursorAt = typeof subagent.attemptCursor?.at === "string" ? subagent.attemptCursor.at : undefined;
    if (cursorAt || subagent.attemptStartedAt)
        return cursorAt ?? subagent.attemptStartedAt;
    return maxIso(subagent.lastActivityAt, subagent.createdAt);
}
function maxIso(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (!Number.isFinite(leftMs))
        return right;
    if (!Number.isFinite(rightMs))
        return left;
    return leftMs >= rightMs ? left : right;
}
function isAtOrAfter(value, cutoff) {
    if (!cutoff)
        return true;
    if (!value)
        return false;
    const valueMs = Date.parse(value);
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(valueMs) || !Number.isFinite(cutoffMs))
        return true;
    return valueMs >= cutoffMs;
}
function isBefore(value, cutoff) {
    if (!value || !cutoff)
        return false;
    const valueMs = Date.parse(value);
    const cutoffMs = Date.parse(cutoff);
    return Number.isFinite(valueMs) && Number.isFinite(cutoffMs) && valueMs < cutoffMs;
}
function cleanupMarkerText(value) {
    let trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    trimmed = trimmed
        .replace(/^\*\*/, "")
        .replace(/\*\*$/u, "")
        .trim();
    if (!trimmed || isPlaceholderMarkerText(trimmed))
        return undefined;
    return trimmed;
}
function isPlaceholderMarkerText(value) {
    return /^<\s*(?:summary|summary of changes|specific blocker|specific blocker and what input\/state change is needed)\b/i.test(value.trim());
}
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => {
        if (typeof part === "string")
            return part;
        if (!part || typeof part !== "object")
            return "";
        const record = part;
        if (typeof record.text === "string")
            return record.text;
        if (typeof record.thinking === "string")
            return record.thinking;
        if (typeof record.result === "string")
            return record.result;
        return "";
    })
        .filter(Boolean)
        .join("\n");
}
//# sourceMappingURL=subagent-adapter.js.map