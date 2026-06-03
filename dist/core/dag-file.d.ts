import { type GoalDagPlanOptions } from "./dag-scheduler.js";
import { type GoalModelRoutingConfig } from "./model-routing.js";
import type { GoalDagConflictHints, GoalDagNode } from "./types.js";
import type { GoalDagPlannedNodesResult, GoalDagPlannerResult } from "./dag-planner.js";
export interface GoalDagFileDocument {
    version: 1;
    objective: string;
    defaults?: GoalDagFileDefaults;
    modelRouting?: GoalModelRoutingConfig;
    nodes: GoalDagFileNode[];
}
export interface GoalDagFileDefaults {
    outputs?: string[];
    validators?: string[];
    workspaceStrategy?: string;
    completionGates?: string[];
    conflicts?: GoalDagConflictHints;
    modelScenario?: string;
}
export interface GoalDagFileNode {
    id: string;
    objective: string;
    after?: string[];
    outputs?: string[];
    validators?: string[];
    conflicts?: GoalDagConflictHints;
    scope?: string;
    workspaceStrategy?: string;
    risk?: GoalDagNode["risk"];
    completionGates?: string[];
    modelScenario?: string;
}
export interface GoalDagFilePlanOptions extends GoalDagPlanOptions {
    maxNodes?: number;
}
export declare function parseGoalDagFileContent(content: string): GoalDagFileDocument;
export declare function parseGoalDagFileDocument(input: unknown): GoalDagFileDocument;
export declare function planGoalDagFromFileDocument(goalId: string, document: GoalDagFileDocument, options?: GoalDagFilePlanOptions): GoalDagPlannerResult;
export declare function createGoalDagNodesFromFileDocument(goalId: string, document: GoalDagFileDocument, options?: GoalDagFilePlanOptions): GoalDagPlannedNodesResult;
export declare function createGoalDagNodesFromFileContent(goalId: string, content: string, options?: GoalDagFilePlanOptions): GoalDagPlannedNodesResult;
