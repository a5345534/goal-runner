import { type GoalDagPlanNodeInput, type GoalDagPlanOptions } from "./dag-scheduler.js";
import type { GoalDagConflictHints, GoalDagNode } from "./types.js";
export type GoalDagPlannerDependencyMode = "sequential" | "independent";
export interface GoalDagObjectivePlanOptions extends GoalDagPlanOptions {
    /** Default validators copied onto every planned node unless overridden by inline annotations. */
    defaultValidators?: string[];
    /** Default expected outputs copied onto every planned node unless overridden by inline annotations. */
    defaultExpectedOutputs?: string[];
    /** Default conflict hints copied onto every planned node unless overridden by inline annotations. */
    defaultConflictHints?: GoalDagConflictHints;
    /** Default dependency behavior for explicit task lists. Defaults to sequential. */
    dependencyMode?: GoalDagPlannerDependencyMode;
    /** Maximum number of nodes the deterministic planner may emit. Defaults to 20. */
    maxNodes?: number;
}
export interface GoalDagPlannerResult {
    goalId: string;
    nodeInputs: GoalDagPlanNodeInput[];
    rationale: string[];
    warnings: string[];
}
export interface GoalDagPlannedNodesResult extends GoalDagPlannerResult {
    nodes: GoalDagNode[];
}
export declare function planGoalDagFromObjective(goalId: string, objectiveInput: string, options?: GoalDagObjectivePlanOptions): GoalDagPlannerResult;
export declare function createGoalDagNodesFromObjective(goalId: string, objective: string, options?: GoalDagObjectivePlanOptions): GoalDagPlannedNodesResult;
