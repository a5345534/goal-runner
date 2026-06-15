// OpenCode session transcript readers and token normalizers.
//
// The Pi adapter reads session JSONL files directly. The opencode
// adapter uses the opencode SDK (`client.session.messages`) to fetch
// messages, then normalises them into a portable shape the runtime and
// the audits can consume.
//
// We deliberately keep this module pure: no side effects, no
// filesystem-mutating operations, and no opencode-specific state. The
// runtime callbacks accept a `collectCompletionEvidence` function that
// returns a `GoalDecisionEvidence`; this module builds that evidence
// from a session id + the opencode client.
const RESULT_MARKER = /(?:^|\n)\s*SUBAGENT_RESULT\s*:\s*([\s\S]*?)(?=\n\s*SUBAGENT_[A-Z_]+\s*:|$)/i;
const BLOCKED_MARKER = /(?:^|\n)\s*SUBAGENT_BLOCKED\s*:\s*([\s\S]*?)(?=\n\s*SUBAGENT_[A-Z_]+\s*:|$)/i;
const STATUS_BLOCKED_MARKER = /(?:^|\n)\s*SUBAGENT_STATUS\s*:\s*blocked\b/i;
export async function readOpencodeSessionTranscript(options) {
    const messages = await readOpencodeSessionMessages(options);
    return summariseOpencodeSession(messages);
}
export async function readOpencodeSessionMessages(options) {
    if (!options.client.session?.messages)
        return [];
    const response = await options.client.session.messages({ sessionID: options.sessionID });
    if (response.error)
        return [];
    return Array.isArray(response.data) ? response.data : [];
}
export function summariseOpencodeSession(messages) {
    const snapshot = {
        messages,
        hasError: false,
        hasAborted: false,
        hasBlockedMarker: false,
        hasResultMarker: false,
    };
    let lastAssistantText;
    let lastToolName;
    let lastActivityAt;
    for (const message of messages) {
        if (typeof message?.time?.completed === "number") {
            lastActivityAt = new Date(message.time.completed).toISOString();
        }
        else if (typeof message?.time?.created === "number" && !lastActivityAt) {
            lastActivityAt = new Date(message.time.created).toISOString();
        }
        if (message?.stopReason === "aborted")
            snapshot.hasAborted = true;
        if (message?.stopReason === "error" || message?.errorMessage)
            snapshot.hasError = true;
        const text = textFromMessageContent(message);
        if (text)
            lastAssistantText = text;
        if (RESULT_MARKER.test(text ?? ""))
            snapshot.hasResultMarker = true;
        if (BLOCKED_MARKER.test(text ?? "") || STATUS_BLOCKED_MARKER.test(text ?? ""))
            snapshot.hasBlockedMarker = true;
        for (const part of message.parts ?? []) {
            if (part?.type === "tool" || part?.type === "toolCall" || part?.type === "tool-call") {
                const toolName = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined;
                if (toolName)
                    lastToolName = toolName;
            }
        }
    }
    snapshot.lastAssistantText = lastAssistantText;
    snapshot.lastToolName = lastToolName;
    snapshot.lastActivityAt = lastActivityAt;
    return snapshot;
}
export function readOpencodeTokenUsage(messages) {
    let input = 0;
    let output = 0;
    let counted = 0;
    for (const message of messages) {
        if (message?.role !== "assistant")
            continue;
        const tokens = message.tokens;
        if (!tokens)
            continue;
        if (typeof tokens.input === "number" && Number.isFinite(tokens.input) && tokens.input > 0) {
            input += Math.trunc(tokens.input);
            counted += 1;
        }
        if (typeof tokens.output === "number" && Number.isFinite(tokens.output) && tokens.output > 0) {
            output += Math.trunc(tokens.output);
            counted += 1;
        }
    }
    if (counted === 0)
        return {};
    return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}
export function buildOpencodeCompletionEvidence(goalObjective, messages, cwd) {
    const toolNames = new Set();
    const commands = [];
    const verificationSignals = [];
    const artifacts = [];
    for (const message of messages) {
        for (const part of message.parts ?? []) {
            if (part?.type === "tool" || part?.type === "toolCall" || part?.type === "tool-call") {
                const toolName = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined;
                if (toolName)
                    toolNames.add(toolName);
                const command = extractShellCommandFromPart(part);
                if (command) {
                    commands.push(command);
                    if (isVerificationCommand(command))
                        verificationSignals.push(`command:${command}`);
                }
                const path = extractPathFromPart(part);
                if (path)
                    artifacts.push(path);
            }
            if (part?.type === "text" && typeof part.text === "string") {
                const signal = verificationSignalFromText(part.text);
                if (signal)
                    verificationSignals.push(signal);
            }
        }
        const text = textFromMessageContent(message);
        if (text) {
            const signal = verificationSignalFromText(text);
            if (signal)
                verificationSignals.push(signal);
        }
    }
    const uniqueCommands = uniq(commands).slice(-10);
    const uniqueSignals = uniq(verificationSignals).slice(-20);
    const uniqueTools = [...toolNames].sort();
    return {
        source: "opencode-session-transcript",
        summary: uniqueSignals.length > 0
            ? `Found ${uniqueSignals.length} verification signal(s) in the opencode transcript.`
            : `Found ${uniqueTools.length} task tool(s) in the opencode transcript.`,
        verificationSignals: uniqueSignals,
        commands: uniqueCommands,
        artifacts: uniq(artifacts).slice(-20),
        toolNames: uniqueTools,
        objective: goalObjective,
        cwd,
    };
}
function textFromMessageContent(message) {
    if (!message)
        return undefined;
    const parts = message.parts ?? [];
    const chunks = [];
    for (const part of parts) {
        if (typeof part?.text === "string")
            chunks.push(part.text);
        if (part?.type === "text" && typeof part.text === "string")
            chunks.push(part.text);
    }
    if (chunks.length === 0 && typeof message.content === "string")
        return message.content;
    return chunks.length > 0 ? chunks.join("\n").trim() : undefined;
}
function extractShellCommandFromPart(part) {
    const args = part.args;
    if (args && typeof args.command === "string")
        return args.command;
    if (args && typeof args.cmd === "string")
        return args.cmd;
    const content = part.content;
    if (content && typeof content === "object") {
        const record = content;
        if (typeof record.command === "string")
            return record.command;
    }
    return undefined;
}
function extractPathFromPart(part) {
    const args = part.args;
    if (args && typeof args.path === "string")
        return args.path;
    if (args && typeof args.filePath === "string")
        return args.filePath;
    if (args && typeof args.file === "string")
        return args.file;
    return undefined;
}
function isVerificationCommand(command) {
    return /(^|\s)(npm\s+run\s+(check|test|build)|npm\s+test|pnpm\s+(test|build|check)|yarn\s+(test|build|check)|mvn\s+test|gradle\s+test|pytest|go\s+test|cargo\s+test|openspec\s+validate|archive-preflight|tsc|eslint)\b/i.test(command);
}
function verificationSignalFromText(text) {
    const line = text
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => /(pass(ed)?|valid|success|succeeded|ok|no errors|0 failing|build success|change .* is valid|通過|成功)/i.test(value));
    return line ? `text:${line.slice(0, 240)}` : undefined;
}
function uniq(values) {
    return [...new Set(values)];
}
//# sourceMappingURL=session-transcript.js.map