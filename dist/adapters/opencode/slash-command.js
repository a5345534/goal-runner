// Slash-command argument parser for the opencode `/goal` entry points.
//
// The Pi adapter accepts `/goal <objective>` and `/goal <subcommand> ...`
// as a single string. The opencode adapter exposes the same surface
// through a `goal_command` tool whose `args.command` is the raw argument
// string, and (in TUI mode) through a `/goal` slash command that opens a
// `DialogPrompt` and forwards the captured string.
//
// This module centralises the argument parsing so the tool handler and
// the TUI slash command share the same code path and the same subcommand
// grammar.
import { parseGoalWorkspaceFlags, tokenize } from "./workspace.js";
export const OPENCODE_GOAL_TOOL = "goal_command";
export const OPENCODE_GOAL_SLASH = "goal";
export const OPENCODE_GOAL_SUBCOMMAND_SET = [
    "list",
    "status",
    "monitor",
    "pause",
    "resume",
    "clear",
    "edit",
    "budget",
];
const SLASH_ARGUMENT_PREFIX = /^\s*\/goal\s*/i;
export function stripSlashPrefix(input) {
    return input.replace(SLASH_ARGUMENT_PREFIX, "").trim();
}
export function parseOpencodeGoalCommand(input) {
    const trimmed = stripSlashPrefix(input);
    if (!trimmed)
        return { kind: "show", workspace: { remainingArgs: "" }, remaining: "" };
    try {
        const tokens = tokenize(trimmed);
        const workspace = parseGoalWorkspaceFlags(trimmed);
        const [first, second] = tokens;
        if (first === "edit")
            return { kind: "edit", workspace, remaining: workspace.remainingArgs };
        if (first === "budget")
            return { kind: "budget", workspace, remaining: workspace.remainingArgs };
        if (first && OPENCODE_GOAL_SUBCOMMAND_SET.includes(first)) {
            return {
                kind: "subcommand",
                subcommand: first,
                workspace,
                remaining: workspace.remainingArgs,
            };
        }
        return { kind: "start", workspace, remaining: workspace.remainingArgs };
    }
    catch (error) {
        return {
            kind: "invalid",
            workspace: { remainingArgs: trimmed },
            remaining: trimmed,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function isLikelyObjectiveToken(first, _second) {
    // Reserved for the rare case where a subcommand is followed by a
    // word that is not a goal-ref. Currently unused: the parser routes
    // `edit` and `budget` to their dedicated kinds first, and the
    // remaining subcommands never have an "objective" form.
    return first === "list" || first === "status" || first === "monitor" || first === "pause" || first === "resume" || first === "clear";
}
export function formatOpencodeGoalToolDescription() {
    return [
        "Run a /goal command on behalf of the user.",
        "Pass the full /goal argument string after the slash. Examples:",
        '  command: "migrate the API to v2"',
        '  command: "--workspace ./repo --branch main implement auth"',
        '  command: "--dag .goal/backend.dag.json"  (objective comes from the file)',
        '  command: "--model openai-codex/gpt-5.5 implement feature"',
        '  command: "--model-routing-file .goal/model-routing.json implement"',
        '  command: "list"',
        '  command: "status"',
        '  command: "monitor"',
        '  command: "pause"',
        '  command: "resume"',
        '  command: "edit"  (interactive editor when no objective follows)',
        '  command: "budget 200k"',
        "The plugin maps the parsed command through the same portable /goal",
        "runtime used by the Pi adapter; do not translate the command before",
        "calling this tool. Pass the user's input verbatim, including any",
        "--workspace/--branch/--ref/--dag/--model/--model-routing/--model-routing-file/--tokens flags.",
    ].join(" ");
}
//# sourceMappingURL=slash-command.js.map