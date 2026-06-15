// Heuristic completion auditor for the opencode adapter.
//
// The Pi adapter enables a transcript heuristic by default; the
// opencode adapter does the same with `source =
// "opencode-transcript-heuristic-auditor"`. Hosts can disable the
// heuristic with `AGENT_GOAL_COMPLETION_AUDIT=off` (matching the Pi
// contract) or replace it through the runtime callback contract.
const MEANINGFUL_PROGRESS_TOOL_SET = new Set(["write", "edit", "bash", "read", "grep", "find", "ls"]);
export function isOpencodeCompletionAuditEnabled() {
    const value = String(process.env.AGENT_GOAL_COMPLETION_AUDIT ?? process.env.OPENCODE_GOAL_COMPLETION_AUDIT ?? "heuristic").toLowerCase();
    return value !== "0" && value !== "false" && value !== "off" && value !== "disabled";
}
export function opencodeHeuristicCompletionAudit(request) {
    const evidence = request.completionEvidence;
    const signals = Array.isArray(evidence?.verificationSignals) ? evidence.verificationSignals : [];
    const toolNames = Array.isArray(evidence?.toolNames) ? evidence.toolNames.filter((value) => typeof value === "string") : [];
    const commands = Array.isArray(evidence?.commands) ? evidence.commands.filter((value) => typeof value === "string") : [];
    const hasTaskTool = toolNames.some((toolName) => MEANINGFUL_PROGRESS_TOOL_SET.has(toolName));
    const hasVerification = signals.length > 0 || commands.some(isOpencodeVerificationCommand);
    if (hasVerification || hasTaskTool) {
        return {
            approved: true,
            source: "opencode-transcript-heuristic-auditor",
            summary: hasVerification
                ? "Completion approved: opencode transcript contains verification evidence."
                : "Completion approved: opencode transcript contains task-relevant tool evidence.",
            evidence,
        };
    }
    return {
        approved: false,
        source: "opencode-transcript-heuristic-auditor",
        summary: "No task-relevant tool use or verification evidence was found in the opencode transcript for this goal.",
        report: "Inspect current artifacts, run or cite verification, then request completion again.",
        evidence,
    };
}
function isOpencodeVerificationCommand(command) {
    return /(^|\s)(npm\s+run\s+(check|test|build)|npm\s+test|pnpm\s+(test|build|check)|yarn\s+(test|build|check)|mvn\s+test|gradle\s+test|pytest|go\s+test|cargo\s+test|openspec\s+validate|archive-preflight|tsc|eslint)\b/i.test(command);
}
//# sourceMappingURL=completion-audit.js.map