import type { GoalDagNode } from "./types.js";
export declare const EXECUTOR_GUARDRAIL_TAG = "[CONTROLLER EXECUTION POLICY]";
export declare const QUALITY_PROFILE_TAG = "[QUALITY PROFILE REQUIREMENTS]";
/**
 * Render quality profile guardrail lines based on the node's validation contract.
 * These are injected as prompt-time requirements for the executor.
 */
export declare function renderQualityProfileGuardrailLines(node: GoalDagNode): string[];
/**
 * Controller-owned execution guardrails that every DAG-node executor should see,
 * even when callers provide a custom node prompt. These are prompt-time hints only;
 * controller validation remains the source of truth.
 */
export declare function renderExecutorGuardrailLines(node: GoalDagNode): string[];
export declare function renderExecutorGuardrails(node: GoalDagNode): string;
export declare function promptIncludesExecutorGuardrails(prompt: string | undefined): boolean;
/**
 * Check if a rendered prompt includes quality profile requirements.
 */
export declare function promptIncludesQualityProfile(prompt: string | undefined): boolean;
