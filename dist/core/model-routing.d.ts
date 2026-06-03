import type { GoalDagNode } from "./types.js";
export interface GoalModelRoutingConfig {
    scenarios: Record<string, GoalModelScenario>;
    controllerScenario?: string;
    defaultSubagentScenario?: string;
    rules?: GoalModelRoutingRule[];
}
export interface GoalModelScenario {
    /** Harness-native model argument, for example "openai-codex/gpt-5.5". */
    model: string;
    description?: string;
}
export interface GoalModelRoutingRule {
    scenario: string;
    when?: GoalModelRoutingRuleMatch;
}
export interface GoalModelRoutingRuleMatch {
    nodeIds?: string[];
    scopes?: string[];
    risks?: Array<NonNullable<GoalDagNode["risk"]>>;
    modules?: string[];
    capabilities?: string[];
    files?: string[];
    objectiveIncludes?: string[];
    hasValidators?: boolean;
    hasOutputs?: boolean;
}
export interface GoalModelScenarioSelection {
    scenario?: string;
    model?: string;
    reason: string;
}
export declare function parseGoalModelRoutingConfig(input: unknown, path?: string): GoalModelRoutingConfig;
export declare function parseGoalModelRoutingConfigJson(json: string, path?: string): GoalModelRoutingConfig;
export declare function resolveControllerModelArg(config: GoalModelRoutingConfig | undefined, fallbackModelArg?: string): GoalModelScenarioSelection;
export declare function selectModelScenarioForNode(node: Pick<GoalDagNode, "nodeId" | "scope" | "risk" | "objective" | "validators" | "expectedOutputs" | "conflictHints" | "modelScenario">, config: GoalModelRoutingConfig | undefined, fallbackModelArg?: string): GoalModelScenarioSelection;
export declare function assertKnownModelScenario(config: GoalModelRoutingConfig | undefined, scenario: string, path: string): void;
