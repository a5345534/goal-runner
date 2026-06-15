import type { GoalDagNode } from "./types.js";
export declare const EXECUTOR_GUARDRAIL_TAG = "[CONTROLLER EXECUTION POLICY]";
/**
 * Controller-owned execution guardrails that every DAG-node executor should see,
 * even when callers provide a custom node prompt. These are prompt-time hints only;
 * controller validation remains the source of truth.
 */
export declare function renderExecutorGuardrailLines(node: GoalDagNode): string[];
export declare function renderExecutorGuardrails(node: GoalDagNode): string;
export declare function promptIncludesExecutorGuardrails(prompt: string | undefined): boolean;
