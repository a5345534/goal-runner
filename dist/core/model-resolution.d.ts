import { type GoalModelBindingCatalog, type GoalModelClassCatalog, type GoalModelMinimumRequirements, type GoalModelNormalizedBindingCatalog, type GoalModelResolution } from "goal-contract";
export interface GoalModelResolutionRequest {
    harness: string;
    role?: string;
    modelScenario?: string;
    modelClass: string;
    bindingSource?: string;
    classCatalog?: GoalModelClassCatalog;
    bindingCatalog?: GoalModelBindingCatalog;
    env?: NodeJS.ProcessEnv;
}
export interface GoalModelResolutionResult {
    modelArg: string;
    evidence: GoalModelResolution;
}
export declare function resolveGoalModelForHarness(request: GoalModelResolutionRequest): GoalModelResolutionResult;
export declare function buildBlockedGoalModelResolutionEvidence(input: {
    harness: string;
    role?: string;
    modelScenario?: string;
    modelClass: string;
    minimumRequirements?: GoalModelMinimumRequirements;
    reason: string;
}): GoalModelResolution;
export declare function readModelClassCatalogFromEnvOrBundled(env?: NodeJS.ProcessEnv): GoalModelClassCatalog;
export declare function readModelBindingCatalogFromEnvOrBundled(harness: string, env?: NodeJS.ProcessEnv): GoalModelNormalizedBindingCatalog;
export declare function readBundledModelClassCatalog(): GoalModelClassCatalog;
export declare function readBundledModelBindingCatalog(harness: string): GoalModelNormalizedBindingCatalog;
