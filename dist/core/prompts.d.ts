import type { CompletionAuditRequest, GoalRecord } from "./types.js";
export declare function renderUntrustedObjectiveBlock(objective: string, label?: string): string;
export declare function renderContinuationPrompt(goal: GoalRecord): string;
export declare function renderActiveGoalReminderPrompt(goal: GoalRecord): string;
export declare function renderBudgetLimitPrompt(goal: GoalRecord): string;
export declare function renderObjectiveUpdatedPrompt(goal: GoalRecord): string;
export declare function renderCompletionAuditPrompt(request: CompletionAuditRequest): string;
