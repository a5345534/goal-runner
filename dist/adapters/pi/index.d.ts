import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type GoalRecord } from "../../core/index.js";
import { type BackgroundGoalSessionLauncher } from "./background-session.js";
export type { BackgroundGoalSessionHandle, BackgroundGoalSessionLauncher, BackgroundGoalSessionLaunchRequest } from "./background-session.js";
export { PiHarnessSubagentAdapter, createPiHarnessSubagentAdapter, readPiSubagentSessionState, renderPiSubagentInitialPrompt } from "./subagent-adapter.js";
export declare function setPiBackgroundGoalSessionLauncherForTests(launcher?: BackgroundGoalSessionLauncher): void;
export default function goalPiExtension(pi: ExtensionAPI): void;
export declare function readPiAssistantTokenTotalFromEntries(entries: Array<Record<string, unknown>>): number;
export declare function normalizePiAssistantUsage(usage: unknown): number;
export declare function extractAssistantTextForRecovery(message: Record<string, unknown> | undefined): string | undefined;
interface GoalContinuationMetadata {
    goalId: string;
    goalUpdatedAt?: string;
    attemptId?: string;
}
export declare function extractGoalContinuationMetadataFromText(content: unknown): GoalContinuationMetadata | undefined;
export declare function rewriteQueuedGoalContinuationMessages(messages: Array<Record<string, unknown>>, goal: GoalRecord | undefined): {
    messages: Array<Record<string, unknown>>;
    changed: boolean;
};
