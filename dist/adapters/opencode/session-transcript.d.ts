import type { GoalDecisionEvidence, TokenUsageSnapshot } from "../../core/index.js";
export interface OpencodeMessagePart {
    type?: string;
    text?: string;
    tool?: string;
    name?: string;
    callID?: string;
    content?: unknown;
    [key: string]: unknown;
}
export interface OpencodeMessage {
    id?: string;
    role?: string;
    /** opencode stores usage on the assistant message. */
    tokens?: {
        input?: number;
        output?: number;
        cache?: {
            read?: number;
            write?: number;
        };
    };
    /** Assistant stop reason: "stop" | "aborted" | "error" | "length" ... */
    stopReason?: string;
    errorMessage?: string;
    content?: unknown;
    parts?: OpencodeMessagePart[];
    time?: {
        created?: number;
        completed?: number;
    };
    [key: string]: unknown;
}
export interface OpencodeTranscriptSnapshot {
    messages: OpencodeMessage[];
    hasError: boolean;
    hasAborted: boolean;
    hasBlockedMarker: boolean;
    hasResultMarker: boolean;
    hasQuestionMarker: boolean;
    /** Last observed tool name, used by the post-stop guard. */
    lastToolName?: string;
    /** Last observed text snippet, used by audits and the goal reminder. */
    lastAssistantText?: string;
    lastActivityAt?: string;
}
export interface OpencodeReadOptions {
    client: {
        session?: {
            messages?: (params: {
                sessionID: string;
            }) => Promise<{
                data?: OpencodeMessage[];
                error?: unknown;
            }>;
        };
    };
    sessionID: string;
}
export declare function readOpencodeSessionTranscript(options: OpencodeReadOptions): Promise<OpencodeTranscriptSnapshot>;
export declare function readOpencodeSessionMessages(options: OpencodeReadOptions): Promise<OpencodeMessage[]>;
export declare function summariseOpencodeSession(messages: OpencodeMessage[]): OpencodeTranscriptSnapshot;
export declare function readOpencodeTokenUsage(messages: OpencodeMessage[]): TokenUsageSnapshot;
export declare function buildOpencodeCompletionEvidence(goalObjective: string, messages: OpencodeMessage[], cwd: string): GoalDecisionEvidence;
