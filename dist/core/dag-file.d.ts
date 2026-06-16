import { type GoalDagPlanOptions } from "./dag-scheduler.js";
import type { GoalDagPlannedNodesResult, GoalDagPlannerResult } from "./dag-planner.js";
import { parseGoalDagFileContent, parseGoalDagFileDocument, type GoalDagFileDefaults, type GoalDagFileDocument, type GoalDagFileNode } from "goal-contract";
export type { GoalDagFileDocument, GoalDagFileDefaults, GoalDagFileNode };
export { parseGoalDagFileContent, parseGoalDagFileDocument };
export interface GoalDagFilePlanOptions extends GoalDagPlanOptions {
    maxNodes?: number;
}
export declare function planGoalDagFromFileDocument(goalId: string, document: GoalDagFileDocument, options?: GoalDagFilePlanOptions): GoalDagPlannerResult;
export declare function createGoalDagNodesFromFileDocument(goalId: string, document: GoalDagFileDocument, options?: GoalDagFilePlanOptions): GoalDagPlannedNodesResult;
export declare function createGoalDagNodesFromFileContent(goalId: string, content: string, options?: GoalDagFilePlanOptions): GoalDagPlannedNodesResult;
