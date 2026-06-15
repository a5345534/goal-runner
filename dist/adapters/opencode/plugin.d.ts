import { GoalRuntime, SQLiteGoalStore, type GoalSummary } from "../../core/index.js";
import type { OpencodeClient, OpencodePluginHooks, OpencodePluginInput } from "./shims.d.ts";
import { buildOpencodeCompletionEvidence, readOpencodeTokenUsage, summariseOpencodeSession } from "./session-transcript.js";
import { OpencodeHiddenContinuationRegistry } from "./hidden-continuation.js";
import { OpencodeHarnessSubagentAdapter } from "./subagent-adapter.js";
import { parseOpencodeGoalCommand, formatOpencodeGoalToolDescription, stripSlashPrefix, OPENCODE_GOAL_TOOL, OPENCODE_GOAL_SLASH } from "./slash-command.js";
export interface OpencodeGoalPluginOptions {
    /** Override the SQLite state root. Defaults to `AGENT_GOAL_STATE_HOME` or `<cwd>/.goal-runner`, falling back to an existing `<cwd>/.agent-goal-runtime`. */
    stateRoot?: string;
    /** Optional pre-built runtime (used by tests). */
    runtime?: GoalRuntime;
    /** Optional pre-built subagent adapter (used by tests). */
    subagentAdapter?: OpencodeHarnessSubagentAdapter;
    /** Optional now() override (used by tests). */
    now?: () => Date;
}
export interface OpencodeGoalPluginContext {
    store: SQLiteGoalStore;
    runtime: GoalRuntime;
    subagentAdapter: OpencodeHarnessSubagentAdapter;
    registry: OpencodeHiddenContinuationRegistry;
    goalBySessionKey: Map<string, GoalSummary>;
    activeSessionID: string;
    activeCwd: string;
    now: () => Date;
    notifications: Array<{
        sessionID: string;
        level: "info" | "warning" | "error";
        message: string;
    }>;
    lastGoalSummary: Map<string, string>;
    busySessions: Set<string>;
    backgroundPollers: Map<string, ReturnType<typeof setInterval>>;
    backgroundSessions: Map<string, {
        stop: () => void;
    }>;
}
export declare function createOpencodeGoalPluginContext(options?: OpencodeGoalPluginOptions): OpencodeGoalPluginContext;
export declare function setOpencodeClientForTests(client: OpencodeClient): void;
export declare function resetOpencodeClientForTests(): void;
export declare const opencodeGoalPlugin: (input: OpencodePluginInput) => Promise<OpencodePluginHooks>;
export { stripSlashPrefix, parseOpencodeGoalCommand, formatOpencodeGoalToolDescription, OPENCODE_GOAL_TOOL, OPENCODE_GOAL_SLASH, summariseOpencodeSession, buildOpencodeCompletionEvidence, readOpencodeTokenUsage, };
