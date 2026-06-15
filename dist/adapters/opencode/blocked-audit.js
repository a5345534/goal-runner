// Blocked audit evidence builder for the opencode adapter.
//
// Mirrors the Pi adapter's transcript-aware blocked audit. The
// portable runtime enforces a three-consecutive-turn minimum, but the
// adapter extracts a normalised blocker signature from the opencode
// session messages and rejects `update_goal({"status": "blocked"})`
// when the recent signatures do not match across the threshold.
export function buildOpencodeBlockedAuditEvidence(options) {
    const turns = [];
    let current;
    for (const message of options.messages) {
        if (!message || typeof message !== "object")
            continue;
        if (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult")
            continue;
        if (message.role === "assistant") {
            if (current)
                turns.push(current);
            current = { signatures: [], hasUpdateGoalCall: false, timestamp: toIso(message.time?.completed ?? message.time?.created) };
            for (const part of message.parts ?? []) {
                if (!part || typeof part !== "object")
                    continue;
                if ((part.type === "tool" || part.type === "toolCall" || part.type === "tool-call") && (part.tool === "update_goal" || part.name === "update_goal")) {
                    current.hasUpdateGoalCall = true;
                }
                if (typeof part.text === "string") {
                    const signature = signatureFromAssistantText(part.text);
                    if (signature)
                        current.signatures.push(signature);
                }
            }
            continue;
        }
        if (!current)
            continue;
        if (message.role === "toolResult") {
            const signature = signatureFromToolResult(message);
            if (signature)
                current.signatures.push(signature);
        }
    }
    if (current)
        turns.push(current);
    const evidenceTurns = turns.filter((turn) => !turn.hasUpdateGoalCall);
    const recentTurns = evidenceTurns.slice(-options.threshold);
    const signatures = recentTurns
        .map((turn) => turn.signatures[0])
        .filter((signature) => Boolean(signature));
    if (recentTurns.length < options.threshold) {
        return {
            inspectedGoalTurns: recentTurns.length,
            consecutiveMatchingTurns: 0,
            reason: `only ${recentTurns.length} recent goal turn(s) available for transcript audit`,
            source: "opencode-session-transcript",
        };
    }
    if (signatures.length !== recentTurns.length) {
        return {
            inspectedGoalTurns: recentTurns.length,
            consecutiveMatchingTurns: 0,
            reason: "not every recent goal turn contains a recognizable blocker signature",
            source: "opencode-session-transcript",
        };
    }
    const latest = signatures[signatures.length - 1];
    let consecutive = 0;
    for (let index = signatures.length - 1; index >= 0; index -= 1) {
        if (signatures[index] !== latest)
            break;
        consecutive += 1;
    }
    return {
        inspectedGoalTurns: recentTurns.length,
        consecutiveMatchingTurns: consecutive,
        blockerSignature: latest,
        reason: consecutive >= options.threshold ? undefined : "recent blocker signatures are not the same",
        source: "opencode-session-transcript",
    };
}
function signatureFromToolResult(message) {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const text = textFromMessageContent(message);
    const line = firstDiagnosticLine(text);
    return line ? `${toolName}:${normalizeSignature(line)}` : undefined;
}
function signatureFromAssistantText(text) {
    if (!/(blocked|cannot proceed|can't proceed|need user|external state|無法|不能|需要使用者|阻塞|卡住)/i.test(text)) {
        return undefined;
    }
    return `assistant:${normalizeSignature(firstDiagnosticLine(text) ?? text)}`;
}
function textFromMessageContent(message) {
    const chunks = [];
    for (const part of message.parts ?? []) {
        if (typeof part?.text === "string")
            chunks.push(part.text);
    }
    if (chunks.length === 0 && typeof message.content === "string")
        return message.content;
    return chunks.join("\n");
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
function toIso(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return undefined;
    return new Date(value).toISOString();
}
//# sourceMappingURL=blocked-audit.js.map