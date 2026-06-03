import type { GoalDagConflictHints, GoalDagNode, GoalDagNodeStatus, GoalOrchestrationState } from "./types.js";
export interface GoalDagPlanNodeInput {
    nodeId?: string;
    slug?: string;
    objective: string;
    scope?: string;
    dependencyNodeIds?: string[];
    expectedOutputs?: string[];
    validators?: string[];
    workspaceStrategy?: string;
    risk?: GoalDagNode["risk"];
    modelScenario?: string;
    modelArg?: string;
    conflictHints?: GoalDagConflictHints;
    completionGates?: string[];
    status?: GoalDagNodeStatus;
}
export interface GoalDagPlanOptions {
    now?: Date | string;
    defaultWorkspaceStrategy?: string;
    defaultCompletionGates?: string[];
}
export interface GoalDagValidationResult {
    ok: boolean;
    errors: string[];
}
export interface GoalDagSchedulingPolicy {
    /** Maximum nodes to return as schedulable. Defaults to unlimited after accounting for active subagents. */
    maxConcurrentSubagents?: number;
    /** Treat matching conflict-hint file entries as mutually exclusive. Defaults true. */
    serializeOnFiles?: boolean;
    /** Treat matching conflict-hint module entries as mutually exclusive. Defaults true. */
    serializeOnModules?: boolean;
    /** Treat matching conflict-hint capability entries as mutually exclusive. Defaults true. */
    serializeOnCapabilities?: boolean;
}
export interface GoalDagReadyQueue {
    ready: GoalDagNode[];
    blocked: Array<{
        node: GoalDagNode;
        reasons: string[];
    }>;
    running: GoalDagNode[];
    capacity: number;
}
export declare function createGoalDagNodes(goalId: string, inputs: GoalDagPlanNodeInput[], options?: GoalDagPlanOptions): GoalDagNode[];
export declare function validateGoalDag(nodes: GoalDagNode[]): GoalDagValidationResult;
export declare function assertValidGoalDag(nodes: GoalDagNode[]): void;
export declare function getGoalDagReadyQueue(state: GoalOrchestrationState, policy?: GoalDagSchedulingPolicy): GoalDagReadyQueue;
