// Opencode client helpers used by the background launcher and the
// subagent adapter.
//
// The runtime adapter only depends on the slice of the opencode SDK it
// actually exercises; the SDK surface is declared in `./shims.d.ts` and
// the runtime never imports the `@opencode-ai/plugin` package directly.
// This module re-exports the lightweight types and adds a couple of
// helpers that the launcher uses to classify transport errors.
export function isAbortError(error) {
    if (!error)
        return false;
    const message = error instanceof Error ? error.message : String(error);
    return /abort|aborted|cancel/i.test(message);
}
export function isUnavailableError(error) {
    if (!error)
        return false;
    const message = error instanceof Error ? error.message : String(error);
    return /econnrefused|enotfound|fetch failed|network|unavailable|5\d\d/i.test(message);
}
export function createNoopOpencodeClient() {
    return {
        session: {
            create: async () => ({ data: { id: "noop-session" } }),
            get: async ({ sessionID }) => ({ data: { id: sessionID, directory: process.cwd() } }),
            prompt: async () => ({ data: { ok: true } }),
            messages: async () => ({ data: [] }),
            status: async () => ({ data: { type: "idle" } }),
            abort: async () => ({ data: { ok: true } }),
        },
    };
}
//# sourceMappingURL=opencode-client.js.map