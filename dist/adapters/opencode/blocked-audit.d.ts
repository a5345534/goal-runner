import type { BlockedAuditEvidence, GoalRecord } from "../../core/index.js";
import type { OpencodeMessage } from "./session-transcript.js";
export interface OpencodeBlockedAuditOptions {
    messages: OpencodeMessage[];
    threshold: number;
    now?: () => Date;
    goalCreatedAt: string;
}
export declare function buildOpencodeBlockedAuditEvidence(options: OpencodeBlockedAuditOptions): BlockedAuditEvidence;
export type { GoalRecord };
