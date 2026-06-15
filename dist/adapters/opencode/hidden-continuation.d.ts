import type { HiddenGoalTurnRequest, HiddenGoalTurnResult } from "../../core/index.js";
import type { OpencodeClient, OpencodePluginEvent } from "./shims.d.ts";
export declare const OPENCODE_GOAL_CONTINUATION_MARKER = "agent_goal_continuation";
export interface OpencodeHiddenContinuationContext {
    client: OpencodeClient;
    sessionID: string;
    busy?: () => boolean;
    hasQueuedUserInput?: () => boolean;
}
export declare class OpencodeHiddenContinuationRegistry {
    private readonly started;
    private readonly queued;
    remember(attemptId: string, hostPartId: string): void;
    hostPartIdFor(attemptId: string): string | undefined;
    forget(attemptId: string): void;
    size(): number;
}
export declare function startOpencodeHiddenGoalTurn(context: OpencodeHiddenContinuationContext, request: HiddenGoalTurnRequest, registry: OpencodeHiddenContinuationRegistry): Promise<HiddenGoalTurnResult>;
export interface OpencodeGoalContinuationMetadata {
    goalId: string;
    goalUpdatedAt?: string;
    attemptId?: string;
}
export declare function extractOpencodeGoalContinuationMetadata(text: string): OpencodeGoalContinuationMetadata | undefined;
export declare function isOpencodeSessionIdleEvent(event: OpencodePluginEvent): boolean;
export declare function isOpencodeSessionErrorEvent(event: OpencodePluginEvent): boolean;
export declare function isOpencodeSessionCompactedEvent(event: OpencodePluginEvent): boolean;
export declare function extractOpencodeEventSessionID(event: OpencodePluginEvent): string | undefined;
export declare function rewriteOpencodeQueuedContinuations(messages: Array<{
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
}>, isCurrent: (metadata: OpencodeGoalContinuationMetadata) => boolean, currentGoalId?: string): {
    messages: Array<{
        info: Record<string, unknown>;
        parts: Array<Record<string, unknown>>;
    }>;
    changed: boolean;
};
