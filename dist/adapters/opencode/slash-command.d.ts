import { parseGoalWorkspaceFlags } from "./workspace.js";
export declare const OPENCODE_GOAL_TOOL = "goal_command";
export declare const OPENCODE_GOAL_SLASH = "goal";
export declare const OPENCODE_GOAL_SUBCOMMAND_SET: readonly ["list", "status", "monitor", "pause", "resume", "clear", "edit", "budget"];
export type OpencodeGoalSubcommand = (typeof OPENCODE_GOAL_SUBCOMMAND_SET)[number];
export interface OpencodeGoalSlashParse {
    /** What kind of input the user provided. */
    kind: "subcommand" | "start" | "edit" | "budget" | "show" | "invalid";
    /** Recognised subcommand name when kind is "subcommand". */
    subcommand?: OpencodeGoalSubcommand;
    /** Workspace flags parsed out of the input (--workspace/--branch/--ref). */
    workspace: ReturnType<typeof parseGoalWorkspaceFlags>;
    /** Raw remaining argument text after workspace flags are removed. */
    remaining: string;
    /** Free-form error message for the "invalid" kind. */
    error?: string;
}
export declare function stripSlashPrefix(input: string): string;
export declare function parseOpencodeGoalCommand(input: string): OpencodeGoalSlashParse;
export declare function formatOpencodeGoalToolDescription(): string;
