import type { GoalDagNode } from "./types.js";
import { parseGoalModelRoutingConfig, parseGoalModelRoutingConfigJson, type GoalModelRoutingConfig, type GoalModelRoutingRule, type GoalModelRoutingRuleMatch, type GoalModelScenario } from "goal-contract";
export type { GoalModelRoutingConfig, GoalModelRoutingRule, GoalModelRoutingRuleMatch, GoalModelScenario };
export { parseGoalModelRoutingConfig, parseGoalModelRoutingConfigJson };
export interface GoalModelScenarioSelection {
    scenario?: string;
    modelClass?: string;
    reason: string;
}
export declare function resolveControllerModelClass(config: GoalModelRoutingConfig | undefined): GoalModelScenarioSelection;
export declare function selectModelScenarioForNode(node: {
    nodeId: string;
    objective: string;
    scope?: string;
    risk?: GoalDagNode["risk"];
    expectedOutputs: string[];
    validators: string[];
    conflictHints?: {
        files?: string[];
        modules?: string[];
        capabilities?: string[];
    };
    modelScenario?: string;
}, config?: GoalModelRoutingConfig): GoalModelScenarioSelection;
export declare function assertKnownModelScenario(config: GoalModelRoutingConfig | undefined, scenario: string, path: string): void;
