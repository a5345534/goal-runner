import type { CompletionAuditRequest, GoalDagNode, GoalRecord } from "./types.js";
export declare function renderUntrustedObjectiveBlock(objective: string, label?: string): string;
export declare function renderContinuationPrompt(goal: GoalRecord): string;
export declare function renderActiveGoalReminderPrompt(goal: GoalRecord): string;
export declare function renderBudgetLimitPrompt(goal: GoalRecord): string;
export declare function renderObjectiveUpdatedPrompt(goal: GoalRecord): string;
export declare function renderCompletionAuditPrompt(request: CompletionAuditRequest): string;
export declare function renderControllerAuditPrompt(snapshot: unknown): string;
/**
 * Render execution discipline envelope for a node's resolved quality profiles.
 * Returns an array of lines to be injected into the subagent prompt.
 */
export declare function renderQualityProfileEnvelope(node: GoalDagNode): string[];
