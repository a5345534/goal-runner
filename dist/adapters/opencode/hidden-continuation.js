// Hidden continuation adapter for the opencode harness.
//
// The Pi adapter implements hidden continuation by calling
// `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` on
// the host's sendMessage API. The opencode adapter does not have a
// `sendMessage` API; instead, it sends a text part to the current
// opencode session through `client.session.prompt`. The model in the
// opencode session will then process the continuation as a new turn.
//
// We track `attemptId -> hostPartId` so the same attempt is never sent
// twice, and we expose a `rewriteOpencodeQueuedContinuations` helper
// that the `experimental.chat.messages.transform` hook uses to mark
// stale bookkeeping messages.
export const OPENCODE_GOAL_CONTINUATION_MARKER = "agent_goal_continuation";
export class OpencodeHiddenContinuationRegistry {
    started = new Map();
    queued = new Map();
    remember(attemptId, hostPartId) {
        this.started.set(attemptId, hostPartId);
    }
    hostPartIdFor(attemptId) {
        return this.started.get(attemptId) ?? this.queued.get(attemptId);
    }
    forget(attemptId) {
        this.started.delete(attemptId);
        this.queued.delete(attemptId);
    }
    size() {
        return this.started.size + this.queued.size;
    }
}
export async function startOpencodeHiddenGoalTurn(context, request, registry) {
    if (!context.client.session?.prompt) {
        return { kind: "fatalFailure", error: "opencode client does not support session.prompt" };
    }
    if (registry.hostPartIdFor(request.attemptId)) {
        return { kind: "alreadyStarted", hostTurnId: registry.hostPartIdFor(request.attemptId) };
    }
    if (context.busy?.())
        return { kind: "skipped", reason: "active turn is running" };
    if (context.hasQueuedUserInput?.())
        return { kind: "skipped", reason: "user input is queued" };
    const hostPartId = `oc-hidden-${request.attemptId}`;
    try {
        const response = await context.client.session.prompt({
            sessionID: context.sessionID,
            parts: [
                {
                    type: "text",
                    text: renderOpencodeGoalContinuationMessage(request),
                },
            ],
        });
        if (response?.error) {
            return { kind: "retryableFailure", error: stringifyError(response.error) };
        }
        registry.remember(request.attemptId, hostPartId);
        return { kind: "started", hostTurnId: hostPartId };
    }
    catch (error) {
        return { kind: "retryableFailure", error: error instanceof Error ? error.message : String(error) };
    }
}
function renderOpencodeGoalContinuationMessage(request) {
    return [
        `<${OPENCODE_GOAL_CONTINUATION_MARKER} goal_id="${escapeAttribute(request.goalId)}" goal_updated_at="${escapeAttribute(request.goalUpdatedAt)}" attempt_id="${escapeAttribute(request.attemptId)}">`,
        request.renderedPrompt,
        `</${OPENCODE_GOAL_CONTINUATION_MARKER}>`,
    ].join("\n");
}
function escapeAttribute(value) {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export function extractOpencodeGoalContinuationMetadata(text) {
    const match = new RegExp(`^<${OPENCODE_GOAL_CONTINUATION_MARKER}\\s+([^>]*)>`).exec(text.trimStart());
    if (!match)
        return undefined;
    const attrs = match[1] ?? "";
    const goalId = attributeValue(attrs, "goal_id");
    if (!goalId)
        return undefined;
    return {
        goalId,
        goalUpdatedAt: attributeValue(attrs, "goal_updated_at"),
        attemptId: attributeValue(attrs, "attempt_id"),
    };
}
function attributeValue(attrs, name) {
    const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return match ? unescapeAttribute(match[1] ?? "") : undefined;
}
function unescapeAttribute(value) {
    return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
function stringifyError(value) {
    if (value instanceof Error)
        return value.message;
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
export function isOpencodeSessionIdleEvent(event) {
    return event?.type === "session.idle";
}
export function isOpencodeSessionErrorEvent(event) {
    return event?.type === "session.error";
}
export function isOpencodeSessionCompactedEvent(event) {
    return event?.type === "session.compacted";
}
export function extractOpencodeEventSessionID(event) {
    const properties = event.properties;
    return typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
}
export function rewriteOpencodeQueuedContinuations(messages, isCurrent, currentGoalId) {
    const metadataByIndex = new Map();
    const currentIndices = [];
    messages.forEach((message, index) => {
        for (const part of message.parts) {
            if (part.type !== "text" || typeof part.text !== "string")
                continue;
            const metadata = extractOpencodeGoalContinuationMetadata(part.text);
            if (!metadata)
                continue;
            metadataByIndex.set(index, metadata);
            if (isCurrent(metadata))
                currentIndices.push(index);
            break;
        }
    });
    const latest = currentIndices.at(-1);
    let changed = false;
    const rewritten = messages.map((message, index) => {
        const metadata = metadataByIndex.get(index);
        if (!metadata)
            return message;
        if (index === latest)
            return message;
        changed = true;
        if (isCurrent(metadata)) {
            return supersededOpencodeContinuationMessage(message, metadata);
        }
        return staleOpencodeContinuationMessage(message, metadata, currentGoalId);
    });
    return { messages: rewritten, changed };
}
function staleOpencodeContinuationMessage(message, metadata, currentGoalId) {
    return {
        info: { ...message.info, kind: "stale_goal_continuation", goalId: metadata.goalId, currentGoalId: currentGoalId ?? null },
        parts: [
            {
                type: "text",
                text: [
                    "Stale hidden goal continuation bookkeeping.",
                    `Queued goal id: ${metadata.goalId}.`,
                    currentGoalId ? `Current goal id: ${currentGoalId}.` : "There is no current goal.",
                    "Ignore this message; do not perform work for the queued goal id above or mention this cancellation to the user.",
                ].join("\n"),
            },
        ],
    };
}
function supersededOpencodeContinuationMessage(message, metadata) {
    return {
        info: { ...message.info, kind: "superseded_goal_continuation", goalId: metadata.goalId },
        parts: [
            {
                type: "text",
                text: [
                    "Superseded hidden goal continuation bookkeeping.",
                    `Goal id: ${metadata.goalId}.`,
                    "A newer continuation for this active goal appears later in context.",
                    "Ignore this message; do not perform work for it or mention it to the user.",
                ].join("\n"),
            },
        ],
    };
}
//# sourceMappingURL=hidden-continuation.js.map